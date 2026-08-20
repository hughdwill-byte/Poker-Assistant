/*
 * watch.js - "Watch mode": read a shared browser tab/window live and feed the
 * recognised cards into the Poker Assistant, so you don't type them by hand.
 *
 * How it works
 * ------------
 * 1. You share a tab or window with the Screen Capture API (getDisplayMedia).
 *    This can be a DIFFERENT site than this app - the browser streams its
 *    pixels to us and, because you consented, we can read them off a canvas.
 * 2. You calibrate once: drag a box over each of your two hole cards and the
 *    five board positions. Boxes are saved (normalised) in localStorage.
 * 3. While watching, every frame each box is cropped and matched against a
 *    small library of card "signatures". Unknown cards are shown for you to
 *    label once ("teach"); after that they're recognised automatically.
 * 4. Stable readings are pushed into the table via window.PokerAssistant,
 *    which recomputes the odds live.
 *
 * Scope: this v1 reads YOUR cards and the BOARD (the big manual-work saver and
 * the reliable part). Reading opponents' bet amounts by generic vision is not
 * attempted - enter those in the panel. Desktop only (iOS has no screen share).
 *
 * This is a heuristic template matcher, not a trained model: it is only as good
 * as your calibration and the cards you teach it, and it never plays for you.
 */
(function () {
  "use strict";
  var API = window.PokerAssistant;
  var Poker = window.Poker;
  if (!API || !Poker) return;

  var SUPPORTED = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // Card regions we calibrate, in table order.
  var REGION_KEYS = ["hero0", "hero1", "b0", "b1", "b2", "b3", "b4"];
  // Numeric regions read by digit OCR.
  var NUM_KEYS = ["pot", "mystack"];
  var ALL_KEYS = REGION_KEYS.concat(NUM_KEYS);
  var REGION_LABELS = {
    hero0: "Your card 1", hero1: "Your card 2",
    b0: "Flop 1", b1: "Flop 2", b2: "Flop 3", b3: "Turn", b4: "River",
    pot: "Pot (number)", mystack: "My stack (number)",
  };

  // ---------- Persistence ----------
  var LS_REGIONS = "pokerwatch.regions.v1";
  var LS_TEMPLATES = "pokerwatch.templates.v1";
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var regions = loadJSON(LS_REGIONS, {}); // key -> {x,y,w,h} normalised
  var templates = loadJSON(LS_TEMPLATES, []); // [{label, red, vec:[...]}]

  // ---------- Card label <-> id ----------
  var RANK_FROM = { A: 14, K: 13, Q: 12, J: 11, T: 10, "10": 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
  var SUIT_FROM = { c: 0, d: 1, h: 2, s: 3 };
  function labelToId(label) {
    // label like "As", "Th", "10d"
    var suit = label.slice(-1), rank = label.slice(0, -1);
    return Poker.makeId(RANK_FROM[rank], SUIT_FROM[suit]);
  }

  // ---------- Signature / matching ----------
  var SIG_W = 16, SIG_H = 24;
  function signature(img) {
    var sw = img.width, sh = img.height, data = img.data;
    var vec = new Float32Array(SIG_W * SIG_H);
    var tx, ty, x, y;
    for (ty = 0; ty < SIG_H; ty++) {
      for (tx = 0; tx < SIG_W; tx++) {
        var x0 = (tx * sw / SIG_W) | 0, x1 = Math.max(x0 + 1, ((tx + 1) * sw / SIG_W) | 0);
        var y0 = (ty * sh / SIG_H) | 0, y1 = Math.max(y0 + 1, ((ty + 1) * sh / SIG_H) | 0);
        var sum = 0, cnt = 0;
        for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) {
          var i = (y * sw + x) * 4;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          cnt++;
        }
        vec[ty * SIG_W + tx] = sum / (cnt || 1);
      }
    }
    // Colour / occupancy stats over the whole region.
    var bright = 0, red = 0, green = 0, white = 0, total = sw * sh;
    for (var p = 0; p < data.length; p += 4) {
      var r = data[p], g = data[p + 1], b = data[p + 2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (lum > 175) bright++;
      // Near-white card body (bright AND low saturation) - felt-colour agnostic.
      if (lum > 200 && mx - mn < 44) white++;
      if (r > 90 && r - g > 38 && r - b > 38) red++;
      if (g > 70 && g - r > 20 && g - b > 15) green++;
    }
    // Contrast-normalise the shape vector.
    var mean = 0, k;
    for (k = 0; k < vec.length; k++) mean += vec[k];
    mean /= vec.length;
    var sd = 0;
    for (k = 0; k < vec.length; k++) { var d2 = vec[k] - mean; sd += d2 * d2; }
    sd = Math.sqrt(sd / vec.length) || 1;
    for (k = 0; k < vec.length; k++) vec[k] = (vec[k] - mean) / sd;
    return { vec: vec, bright: bright / total, red: red / total, green: green / total, white: white / total };
  }

  function rms(a, b) {
    var s = 0, n = a.length;
    for (var i = 0; i < n; i++) { var d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s / n);
  }

  var threshold = 0.62; // match sensitivity (lower = stricter)

  function classify(sig) {
    // A face-up card is mostly a white body regardless of felt colour; if there
    // is little white and little red pip, the slot is empty (undealt/felt).
    var present = sig.white > 0.12 || sig.red > 0.05;
    if (!present) return { status: "empty" };
    var best = null, bestScore = 1e9;
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      if (t.kind === "digit") continue; // digits matched separately
      var score = rms(t.vec, sig.vec) + 1.4 * Math.abs((t.red || 0) - sig.red);
      if (score < bestScore) { bestScore = score; best = t; }
    }
    if (best && bestScore < threshold) {
      if (best.label === "empty") return { status: "empty" };
      if (best.label === "back") return { status: "back" };
      return { status: "card", id: labelToId(best.label), label: best.label };
    }
    return { status: "unknown" };
  }

  // ---------- Digit OCR (for pot / stack numbers) ----------
  // Estimate the background luminance from the region's border pixels.
  function estimateBg(img) {
    var w = img.width, h = img.height, d = img.data, sum = 0, n = 0;
    function add(x, y) { var i = (y * w + x) * 4; sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    for (var x = 0; x < w; x += 2) { add(x, 0); add(x, h - 1); }
    for (var y = 0; y < h; y += 2) { add(0, y); add(w - 1, y); }
    return sum / (n || 1);
  }
  // Binary ink mask (1 where a pixel is far from the background luminance).
  function inkMask(img, bg) {
    var w = img.width, h = img.height, d = img.data, m = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (Math.abs(lum - bg) > 60) m[y * w + x] = 1;
    }
    return m;
  }
  // Segment ink columns into glyph x-ranges.
  function segmentGlyphs(mask, w, h) {
    var onThr = Math.max(1, h * 0.06), glyphs = [], run = null;
    for (var x = 0; x < w; x++) {
      var c = 0; for (var y = 0; y < h; y++) c += mask[y * w + x];
      var on = c >= onThr;
      if (on) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; }
      else if (run) { glyphs.push(run); run = null; }
    }
    if (run) glyphs.push(run);
    return glyphs;
  }
  // Crop an arbitrary rectangle to a fresh ImageData.
  function cropRect(img, x0, y0, x1, y1) {
    var w = img.width, nw = Math.max(1, x1 - x0 + 1), nh = Math.max(1, y1 - y0 + 1);
    var out = new ImageData(nw, nh), s = img.data, o = out.data;
    for (var y = 0; y < nh; y++) for (var x = 0; x < nw; x++) {
      var si = ((y0 + y) * w + (x0 + x)) * 4, di = (y * nw + x) * 4;
      o[di] = s[si]; o[di + 1] = s[si + 1]; o[di + 2] = s[si + 2]; o[di + 3] = 255;
    }
    return out;
  }
  // Vertical ink extent of a glyph across its columns.
  function vBounds(mask, w, h, x0, x1) {
    var y0 = h, y1 = -1;
    for (var y = 0; y < h; y++) {
      for (var x = x0; x <= x1; x++) if (mask[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
    }
    if (y1 < 0) { y0 = 0; y1 = h - 1; }
    return { y0: y0, y1: y1 };
  }
  function classifyGlyph(sig) {
    var best = null, bs = 1e9;
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      if (t.kind !== "digit") continue;
      var s = rms(t.vec, sig.vec);
      if (s < bs) { bs = s; best = t; }
    }
    return (best && bs < threshold + 0.18) ? best.label : null; // digits slightly looser
  }
  function parseNumber(str) {
    if (!str || str.indexOf("?") >= 0) return null;
    var mult = 1, s = str.replace(/,/g, "").replace(/\s/g, "");
    if (/k$/i.test(s)) { mult = 1e3; s = s.slice(0, -1); }
    else if (/m$/i.test(s)) { mult = 1e6; s = s.slice(0, -1); }
    var v = parseFloat(s);
    return isFinite(v) ? Math.round(v * mult) : null;
  }
  // Read a numeric region -> { str, value, unknowns:[{img,sig}] }
  function readNumber(img) {
    var w = img.width, h = img.height;
    var bg = estimateBg(img);
    var mask = inkMask(img, bg);
    var glyphs = segmentGlyphs(mask, w, h);
    var str = "", unknowns = [];
    for (var i = 0; i < glyphs.length; i++) {
      var g = glyphs[i];
      if (g.x1 - g.x0 < 1 && i > 0) continue;           // skip 1px specks
      var vb = vBounds(mask, w, h, g.x0, g.x1);          // tight crop both axes
      var sub = cropRect(img, g.x0, vb.y0, g.x1, vb.y1);
      var sig = signature(sub);
      var lab = classifyGlyph(sig);
      if (lab == null) { str += "?"; unknowns.push({ img: sub, sig: sig }); }
      else str += lab;
    }
    return { str: str, value: parseNumber(str), unknowns: unknowns };
  }

  // ---------- Capture plumbing ----------
  var stream = null, video = null, work = null, wctx = null;
  var watching = false, tickTimer = null, fps = 3;

  function stopStream() {
    watching = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    setStatus("Not sharing.");
    updateButtons();
  }

  function startShare() {
    if (!SUPPORTED) return;
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        video.play();
        s.getVideoTracks()[0].addEventListener("ended", stopStream);
        setStatus("Sharing. Calibrate your card boxes, then Start watching.");
        updateButtons();
        drawOverlay();
      })
      .catch(function () { setStatus("Screen share was cancelled."); });
  }

  function grabFrame() {
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    if (work.width !== vw) work.width = vw;
    if (work.height !== vh) work.height = vh;
    wctx.drawImage(video, 0, 0, vw, vh);
    return true;
  }
  function regionImageData(rect) {
    var vw = work.width, vh = work.height;
    var x = Math.max(0, Math.round(rect.x * vw)), y = Math.max(0, Math.round(rect.y * vh));
    var w = Math.max(2, Math.round(rect.w * vw)), h = Math.max(2, Math.round(rect.h * vh));
    w = Math.min(w, vw - x); h = Math.min(h, vh - y);
    return wctx.getImageData(x, y, w, h);
  }

  // ---------- Watch loop ----------
  var stab = {}; // key -> { val, count, sig }
  function tick() {
    if (!grabFrame()) return;
    var reading = { hero: [undefined, undefined], board: [undefined, undefined, undefined, undefined, undefined] };
    var unknowns = [];
    REGION_KEYS.forEach(function (key) {
      var rect = regions[key];
      if (!rect) return;
      var img = regionImageData(rect);
      var sig = signature(img);
      var res = classify(sig);
      var val = res.status === "card" ? "card:" + res.label : res.status;
      var st = stab[key];
      if (st && st.val === val) st.count++;
      else stab[key] = st = { val: val, count: 1 };
      st.sig = sig; st.res = res; st.img = img;
      if (st.count >= 2) {
        if (res.status === "card") setSlot(reading, key, res.id);
        else if (res.status === "empty") setSlot(reading, key, null);
        // 'back'/'unknown' -> leave the manual value alone
        if (res.status === "unknown") unknowns.push({ key: key, kind: "card", img: img, sig: sig });
      }
    });
    // Numeric regions (pot / my stack) via digit OCR.
    NUM_KEYS.forEach(function (key) {
      var rect = regions[key];
      if (!rect) return;
      var num = readNumber(regionImageData(rect));
      var val = "num:" + num.str;
      var st = stab[key];
      if (st && st.val === val) st.count++; else stab[key] = st = { val: val, count: 1 };
      st.num = num;
      if (st.count >= 2 && num.value != null) {
        if (key === "pot") reading.pot = num.value;
        else if (key === "mystack") reading.stack = num.value;
      }
      if (st.count >= 2 && num.unknowns.length) {
        unknowns.push({ key: key, kind: "digit", img: num.unknowns[0].img, sig: num.unknowns[0].sig });
      }
    });
    API.applyReading(reading);
    renderStrip();
    renderTeach(unknowns);
  }
  function setSlot(reading, key, id) {
    if (key === "hero0") reading.hero[0] = id;
    else if (key === "hero1") reading.hero[1] = id;
    else reading.board[+key.slice(1)] = id;
  }

  function startWatching() {
    if (!stream) { setStatus("Share a tab or window first."); return; }
    if (!REGION_KEYS.some(function (k) { return regions[k]; })) { setStatus("Calibrate at least your two cards first."); return; }
    watching = true; stab = {};
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, Math.round(1000 / fps));
    setStatus("Watching live · " + fps + " fps");
    updateButtons();
  }
  function pauseWatching() {
    watching = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    setStatus("Paused.");
    updateButtons();
  }

  // ---------- UI ----------
  var el = {}, calibrating = false, selectedKey = null, dragging = null;

  function h(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function buildModal() {
    var overlay = h("div", "watch-overlay"); overlay.hidden = true; overlay.id = "watch-overlay";
    var modal = h("div", "watch-modal");
    overlay.appendChild(modal);

    var head = h("div", "watch-head");
    head.appendChild(h("span", null, "👁 Watch mode <span class='beta'>beta</span>"));
    var close = h("button", "btn btn-ghost", "✕"); close.addEventListener("click", closeModal);
    head.appendChild(close);
    modal.appendChild(head);

    if (!SUPPORTED) {
      modal.appendChild(h("p", "watch-note",
        "Live screen capture isn't available in this browser. Use desktop Chrome, Edge or Firefox " +
        "(iOS Safari can't share a screen). You can still enter cards by hand."));
      el.overlay = overlay; document.body.appendChild(overlay); return;
    }

    // Toolbar
    var bar = h("div", "watch-bar");
    el.share = mkbtn("Share a tab / window", startShare, "primary");
    el.stop = mkbtn("Stop", stopStream);
    el.calib = mkbtn("Calibrate", toggleCalibrate);
    el.watch = mkbtn("Start watching", toggleWatch, "primary");
    [el.share, el.stop, el.calib, el.watch].forEach(function (b) { bar.appendChild(b); });
    modal.appendChild(bar);

    el.status = h("div", "watch-status", "Share a tab or window to begin.");
    modal.appendChild(el.status);

    // Video + overlay canvas
    var stage = h("div", "watch-stage");
    video = document.createElement("video"); video.muted = true; video.playsInline = true; video.className = "watch-video";
    el.canvas = document.createElement("canvas"); el.canvas.className = "watch-canvas";
    stage.appendChild(video); stage.appendChild(el.canvas);
    modal.appendChild(stage);
    bindCalibrationMouse();

    // Region chips
    el.chips = h("div", "watch-chips");
    ALL_KEYS.forEach(function (key) {
      var c = h("button", "watch-chip" + (NUM_KEYS.indexOf(key) >= 0 ? " num" : ""), REGION_LABELS[key]);
      c.dataset.key = key;
      c.addEventListener("click", function () { selectedKey = key; calibrating = true; refreshChips(); setStatus("Drag a box over " + REGION_LABELS[key] + "."); drawOverlay(); });
      el.chips.appendChild(c);
    });
    modal.appendChild(el.chips);

    // Live results strip
    el.strip = h("div", "watch-strip");
    modal.appendChild(el.strip);

    // Teach panel
    el.teach = h("div", "watch-teach"); el.teach.hidden = true;
    modal.appendChild(el.teach);

    // Settings row
    var settings = h("div", "watch-settings");
    settings.appendChild(labelWrap("Capture rate", rateSlider()));
    settings.appendChild(labelWrap("Match sensitivity", sensSlider()));
    var clear = h("div", "watch-clearbtns");
    clear.appendChild(mkbtn("Clear boxes", function () { regions = {}; saveJSON(LS_REGIONS, regions); refreshChips(); drawOverlay(); setStatus("Calibration cleared."); }));
    clear.appendChild(mkbtn("Forget taught cards", function () { templates = []; saveJSON(LS_TEMPLATES, templates); setStatus("Taught-card library cleared."); }));
    settings.appendChild(clear);
    modal.appendChild(settings);

    modal.appendChild(h("p", "watch-note",
      "One-time setup per site: drag a box over each of your two cards, the five board spots, " +
      "and (optional) the Pot and My-stack numbers. Start watching; when it meets a card or digit " +
      "it doesn't know it asks you to label it once. Then close this panel with ✕ - it keeps " +
      "watching in the background (a ● Watching pill reopens it) and your table updates live."));

    el.overlay = overlay;
    document.body.appendChild(overlay);
    refreshChips();
    updateButtons();
  }

  function mkbtn(text, fn, kind) {
    var b = h("button", "btn" + (kind === "primary" ? " watch-primary" : ""), text);
    b.addEventListener("click", fn); return b;
  }
  function labelWrap(text, node) { var w = h("label", "watch-field"); w.appendChild(h("span", null, text)); w.appendChild(node); return w; }
  function rateSlider() {
    var s = document.createElement("input"); s.type = "range"; s.min = 1; s.max = 6; s.value = fps;
    s.addEventListener("input", function () { fps = +s.value; if (watching) startWatching(); });
    return s;
  }
  function sensSlider() {
    var s = document.createElement("input"); s.type = "range"; s.min = 30; s.max = 110; s.value = Math.round(threshold * 100);
    s.addEventListener("input", function () { threshold = +s.value / 100; });
    return s;
  }

  function setStatus(t) { if (el.status) el.status.textContent = t; }
  function updateButtons() {
    if (!el.watch) return;
    el.watch.textContent = watching ? "Pause" : "Start watching";
    el.calib.classList.toggle("watch-primary", calibrating);
    el.stop.disabled = !stream;
    el.watch.disabled = !stream;
  }
  function toggleCalibrate() { calibrating = !calibrating; if (!calibrating) selectedKey = null; updateButtons(); drawOverlay(); setStatus(calibrating ? "Click a card box below, then drag over it." : "Calibration off."); }
  function toggleWatch() { if (watching) pauseWatching(); else startWatching(); }

  function refreshChips() {
    if (!el.chips) return;
    [].forEach.call(el.chips.children, function (c) {
      var key = c.dataset.key;
      c.classList.toggle("set", !!regions[key]);
      c.classList.toggle("active", selectedKey === key);
    });
  }

  // Calibration drawing + mouse.
  function stageScale() {
    var r = video.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  }
  function drawOverlay() {
    if (!el.canvas || !video) return;
    var r = video.getBoundingClientRect();
    el.canvas.width = r.width; el.canvas.height = r.height;
    var ctx = el.canvas.getContext("2d");
    ctx.clearRect(0, 0, r.width, r.height);
    ALL_KEYS.forEach(function (key) {
      var rect = regions[key]; if (!rect) return;
      ctx.strokeStyle = key === selectedKey ? "#f5b93b"
        : NUM_KEYS.indexOf(key) >= 0 ? "#f5b93b"
        : key.indexOf("hero") === 0 ? "#4ade80" : "#60a5fa";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x * r.width, rect.y * r.height, rect.w * r.width, rect.h * r.height);
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.font = "11px system-ui";
      var label = REGION_LABELS[key];
      ctx.fillRect(rect.x * r.width, rect.y * r.height - 14, ctx.measureText(label).width + 8, 14);
      ctx.fillStyle = "#fff"; ctx.fillText(label, rect.x * r.width + 4, rect.y * r.height - 3);
    });
    if (dragging) {
      ctx.strokeStyle = "#f5b93b"; ctx.setLineDash([5, 3]); ctx.lineWidth = 2;
      ctx.strokeRect(dragging.x, dragging.y, dragging.w, dragging.h); ctx.setLineDash([]);
    }
  }
  function bindCalibrationMouse() {
    var c = el.canvas, start = null;
    function pos(e) { var r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height }; }
    c.addEventListener("mousedown", function (e) {
      if (!calibrating || !selectedKey) { setStatus("Pick a card box below first (Calibrate)."); return; }
      var p = pos(e); start = p; dragging = { x: p.x, y: p.y, w: 0, h: 0 }; e.preventDefault();
    });
    c.addEventListener("mousemove", function (e) {
      if (!start) return; var p = pos(e);
      dragging = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      drawOverlay();
    });
    window.addEventListener("mouseup", function (e) {
      if (!start) return; var p = pos(e);
      var W = start.W, H = start.H;
      var x = Math.min(start.x, p.x) / W, y = Math.min(start.y, p.y) / H;
      var w = Math.abs(p.x - start.x) / W, hh = Math.abs(p.y - start.y) / H;
      start = null; dragging = null;
      if (w > 0.01 && hh > 0.01) {
        regions[selectedKey] = { x: x, y: y, w: w, h: hh };
        saveJSON(LS_REGIONS, regions);
        setStatus(REGION_LABELS[selectedKey] + " box set.");
        // advance to next unset region for convenience
        var next = ALL_KEYS.filter(function (k) { return !regions[k]; })[0];
        selectedKey = next || null;
        if (next) setStatus("Now drag over " + REGION_LABELS[next] + ".");
      }
      refreshChips(); drawOverlay();
    });
  }

  // Live strip of current recognised cards.
  function renderStrip() {
    if (!el.strip) return;
    el.strip.innerHTML = "";
    REGION_KEYS.forEach(function (key) {
      var st = stab[key];
      var chip = h("span", "strip-card");
      if (!regions[key]) { chip.classList.add("off"); chip.textContent = "–"; }
      else if (!st || st.count < 2) { chip.textContent = "…"; }
      else if (st.res.status === "card") { chip.textContent = Poker.cardLabel(st.res.id); chip.classList.add(cardColor(st.res.id)); }
      else if (st.res.status === "empty") { chip.textContent = "·"; chip.classList.add("off"); }
      else { chip.textContent = "?"; chip.classList.add("q"); }
      chip.title = REGION_LABELS[key];
      el.strip.appendChild(chip);
      if (key === "hero1") el.strip.appendChild(h("span", "strip-sep", "|"));
    });
    // Numeric readouts.
    NUM_KEYS.forEach(function (key) {
      if (!regions[key]) return;
      var st = stab[key];
      var txt = (st && st.num) ? (st.num.value != null ? st.num.value.toLocaleString() : st.num.str || "?") : "…";
      var chip = h("span", "strip-num" + (st && st.num && st.num.value == null ? " q" : ""),
        (key === "pot" ? "Pot " : "Stack ") + txt);
      el.strip.appendChild(chip);
    });
  }
  function cardColor(id) { return Poker.SUIT_COLOR[Poker.suitOf(id)]; }

  // Teach panel for unknown cards.
  var teaching = null;
  function renderTeach(unknowns) {
    if (!el.teach) return;
    if (!unknowns.length && !teaching) { el.teach.hidden = true; el.teach.innerHTML = ""; return; }
    if (!teaching && unknowns.length) teaching = unknowns[0];
    if (!teaching) { el.teach.hidden = true; return; }
    el.teach.hidden = false;
    el.teach.innerHTML = "";
    var isDigit = teaching.kind === "digit";
    el.teach.appendChild(h("div", "teach-title",
      (isDigit ? "Unrecognised digit in " : "Unrecognised ") + REGION_LABELS[teaching.key] +
      " — tell me what it is (once):"));
    var body = h("div", "teach-body");
    var thumb = h("canvas", "teach-thumb");
    thumb.width = teaching.img.width; thumb.height = teaching.img.height;
    thumb.getContext("2d").putImageData(teaching.img, 0, 0);
    body.appendChild(thumb);

    var grid = h("div", "teach-grid" + (isDigit ? " digit" : ""));
    if (isDigit) {
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ",", ".", "K", "M"].forEach(function (g) {
        var btn = h("button", "teach-pick", g === "," ? "," : g === "." ? "." : g);
        btn.addEventListener("click", function () { teachAs(g, "digit"); });
        grid.appendChild(btn);
      });
    } else {
      var RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"];
      var SUITS = [["s", "♠", "black"], ["h", "♥", "red"], ["d", "♦", "red"], ["c", "♣", "black"]];
      SUITS.forEach(function (s) {
        RANKS.forEach(function (rk) {
          var lbl = (rk === "10" ? "10" : rk) + s[0];
          var btn = h("button", "teach-pick " + s[2], rk + s[1]);
          btn.addEventListener("click", function () { teachAs(lbl, "card"); });
          grid.appendChild(btn);
        });
      });
    }
    body.appendChild(grid);
    el.teach.appendChild(body);

    var extra = h("div", "teach-extra");
    if (!isDigit) {
      extra.appendChild(mkbtn("It's a face-down card", function () { teachAs("back", "card"); }));
      extra.appendChild(mkbtn("It's empty", function () { teachAs("empty", "card"); }));
    }
    extra.appendChild(mkbtn("Skip", function () { teaching = null; renderTeach([]); }));
    el.teach.appendChild(extra);
  }
  function teachAs(label, kind) {
    if (!teaching) return;
    templates.push({ label: label, kind: kind || "card", red: teaching.sig.red, vec: Array.prototype.slice.call(teaching.sig.vec) });
    saveJSON(LS_TEMPLATES, templates);
    stab[teaching.key] = null; // force re-evaluate
    teaching = null;
    setStatus("Learned it. It'll be recognised automatically from now on.");
  }

  // ---------- open / close ----------
  // While watching we must keep the <video> in the render tree or the browser
  // stops decoding frames. So closing the panel mid-watch only MINIMISES it
  // (moved off-screen but still live); a floating pill reopens it.
  var pill = null;
  function ensurePill() {
    if (pill) return;
    pill = h("button", "watch-pill", "<span class='dot'></span> Watching — tap to open");
    pill.hidden = true;
    pill.addEventListener("click", openModal);
    document.body.appendChild(pill);
  }
  function openModal() {
    if (!el.overlay) buildModal();
    ensurePill();
    el.overlay.classList.remove("min");
    el.overlay.hidden = false;
    pill.hidden = true;
    if (SUPPORTED) { requestAnimationFrame(drawOverlay); }
  }
  function closeModal() {
    if (!el.overlay) return;
    ensurePill();
    if (watching) {
      // keep capturing in the background
      el.overlay.classList.add("min");
      el.overlay.hidden = false;
      pill.hidden = false;
    } else {
      el.overlay.classList.remove("min");
      el.overlay.hidden = true;
      pill.hidden = true;
    }
  }

  // Wire the trigger buttons (added in index.html).
  function bind(id) { var b = document.getElementById(id); if (b) b.addEventListener("click", openModal); }
  bind("btn-watch");
  bind("m-watch");

  window.addEventListener("resize", function () { if (el.overlay && !el.overlay.hidden) drawOverlay(); });

  // Expose a tiny hook for automated testing (no effect in normal use).
  window.PokerWatch = {
    _signature: signature, _classify: classify, _labelToId: labelToId, _readNumber: readNumber,
    _teach: function (label, sig, kind) { templates.push({ label: label, kind: kind || "card", red: sig.red, vec: Array.prototype.slice.call(sig.vec) }); },
    _regions: function () { return regions; }, _templates: function () { return templates; },
    _setWatching: function (v) { watching = v; }, _open: openModal, _close: closeModal,
  };
})();
