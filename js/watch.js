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
  var LS_TEMPLATES = "pokerwatch.templates.v2"; // v2: rank/suit/digit glyphs
  var LS_IGNORE = "pokerwatch.ignore.v1";
  function loadJSON(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var regions = loadJSON(LS_REGIONS, {});     // key -> {x,y,w,h} normalised
  var templates = loadJSON(LS_TEMPLATES, []); // [{kind, label, red, vec:[...]}]
  var ignored = loadJSON(LS_IGNORE, []);      // skipped glyph signatures (won't re-prompt)

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

  // A higher-resolution binary "ink-shape" descriptor for matching individual
  // glyphs (ranks / suits / digits). Built from a mask that was computed on an
  // image WITH background (the whole region), sampled over the glyph's bounding
  // box - crucial, because a tight glyph crop has no background to threshold.
  var GW = 24, GH = 36;
  function glyphVec(mask, w, x0, y0, x1, y1) {
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1, vec = new Float32Array(GW * GH);
    for (var ty = 0; ty < GH; ty++) for (var tx = 0; tx < GW; tx++) {
      var cx0 = x0 + ((tx * bw / GW) | 0), cx1 = Math.max(cx0 + 1, x0 + (((tx + 1) * bw / GW) | 0));
      var cy0 = y0 + ((ty * bh / GH) | 0), cy1 = Math.max(cy0 + 1, y0 + (((ty + 1) * bh / GH) | 0));
      var c = 0, n = 0;
      for (var y = cy0; y < cy1; y++) for (var x = cx0; x < cx1; x++) { c += mask[y * w + x]; n++; }
      vec[ty * GW + tx] = (c / (n || 1)) > 0.28 ? 1 : 0;
    }
    return vec;
  }
  // Colour fractions of an image region's bounding box (for suit red/black and
  // for rejecting colourful chip icons that aren't glyphs).
  function boxColor(img, x0, y0, x1, y1) {
    var w = img.width, d = img.data, red = 0, colorful = 0, tot = 0;
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (r > 90 && r - g > 38 && r - b > 38) red++;
      if (mx - mn > 55 && mx > 70) colorful++; // saturated (not white/grey/black)
      tot++;
    }
    return { red: red / (tot || 1), colorful: colorful / (tot || 1) };
  }

  var threshold = 0.62;  // whole-region present match (legacy)
  var gthr = 0.42;       // rank/digit match distance (must absorb red-vs-black edge noise)
  var sthr = 0.30;       // suit match distance (suits are single-colour, so tighter)

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
  // Estimate the background luminance as the MEDIAN over the region. The
  // dominant surface (white card body, or the dark panel behind a number) sets
  // the background, so text/pips stand out as the minority "ink" - robust even
  // when a bit of felt or border is included in the crop.
  function estimateBg(img) {
    var w = img.width, h = img.height, d = img.data, vals = [];
    var step = Math.max(1, Math.floor(Math.sqrt(w * h / 500)));
    for (var y = 0; y < h; y += step) for (var x = 0; x < w; x += step) {
      var i = (y * w + x) * 4;
      vals.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    vals.sort(function (a, b) { return a - b; });
    return vals[vals.length >> 1];
  }
  // Binary ink mask. A pixel is "ink" if it differs from the background in
  // luminance OR is strongly coloured (saturated). The saturation test makes a
  // RED glyph produce the same shape as a BLACK one, so ranks match across
  // suit colours (a red A and a black A give identical masks).
  function inkMask(img, bg) {
    var w = img.width, h = img.height, d = img.data, m = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b, sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (Math.abs(lum - bg) > 55 || sat > 60) m[y * w + x] = 1;
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
    return (best && bs < gthr) ? best.label : null;
  }
  // Parse a token string of digits, '.' separators and an optional K/M suffix.
  // Rule: a single separator before a K/M suffix is a decimal point (1.4M);
  // all other separators are thousands groupers (990,000 / 1.234.567).
  function parseNumber(str) {
    if (!str || str.indexOf("?") >= 0) return null;
    var mult = 1, s = str;
    var suf = s.match(/[KM]$/i);
    if (suf) { mult = suf[0].toUpperCase() === "M" ? 1e6 : 1e3; s = s.slice(0, -1); }
    var seps = (s.match(/\./g) || []).length;
    var digits = s.replace(/\./g, "");
    if (digits === "" || !/^[0-9]+$/.test(digits)) return null;
    var val = (mult > 1 && seps === 1) ? parseFloat(s) : parseInt(digits, 10);
    return isFinite(val) ? Math.round(val * mult) : null;
  }
  // Read a numeric region -> { str, value, unknowns:[{img,sig,kind}] }
  // Robust to chip icons / commas / noise: we keep only digit-shaped glyphs
  // (tall enough, not too wide, not colourful) and drop the rest, so commas and
  // icons never trigger a "verify this" prompt.
  function readNumber(img) {
    var w = img.width, h = img.height;
    var bg = estimateBg(img);
    var mask = inkMask(img, bg);
    var glyphs = segmentGlyphs(mask, w, h);
    // Measure glyph heights to find the digit height (commas/dots are shorter).
    var metrics = glyphs.map(function (g) {
      var vb = vBounds(mask, w, h, g.x0, g.x1);
      return { g: g, vb: vb, hgt: vb.y1 - vb.y0 + 1, wid: g.x1 - g.x0 + 1 };
    });
    var maxH = 1; metrics.forEach(function (m) { if (m.hgt > maxH) maxH = m.hgt; });
    var tallW = metrics.filter(function (m) { return m.hgt >= 0.55 * maxH; }).map(function (m) { return m.wid; }).sort(function (a, b) { return a - b; });
    var medW = tallW.length ? tallW[tallW.length >> 1] : 1;
    var str = "", unknowns = [];
    for (var i = 0; i < metrics.length; i++) {
      var m = metrics[i];
      var col = boxColor(img, m.g.x0, m.vb.y0, m.g.x1, m.vb.y1);
      if (col.colorful > 0.28) continue;                 // colourful chip icon -> ignore
      if (m.hgt < 0.55 * maxH) { str += "."; continue; } // short = comma/decimal separator
      if (m.wid > 2.6 * medW) continue;                  // wide blob (icon) -> ignore
      var sig = { vec: glyphVec(mask, w, m.g.x0, m.vb.y0, m.g.x1, m.vb.y1), red: col.red };
      var lab = classifyGlyph(sig);
      if (lab == null) {
        if (isIgnored(sig, "digit")) continue;           // user skipped this shape
        str += "?"; unknowns.push({ img: cropRect(img, m.g.x0, m.vb.y0, m.g.x1, m.vb.y1), sig: sig, kind: "digit" });
      } else str += lab;
    }
    return { str: str, value: parseNumber(str), unknowns: unknowns };
  }

  // ---------- Corner-based card recognition (rank + suit separately) ----------
  // Standard cards show the rank then a small suit under it in the corner. We
  // read those two glyphs, so teaching a rank once covers all four suits and a
  // suit once covers all thirteen ranks (~17 teaches for the whole deck).
  var CORNER = { x0: 0.06, y0: 0.04, x1: 0.5, y1: 0.64 };
  var RANK_VAL = { A: 14, K: 13, Q: 12, J: 11, "10": 10, "9": 9, "8": 8, "7": 7, "6": 6, "5": 5, "4": 4, "3": 3, "2": 2 };
  var SUIT_CODE = { c: 0, d: 1, h: 2, s: 3 };

  function subImage(img, fx0, fy0, fx1, fy1) {
    var w = img.width, h = img.height;
    return cropRect(img,
      Math.max(0, Math.floor(fx0 * w)), Math.max(0, Math.floor(fy0 * h)),
      Math.min(w - 1, Math.ceil(fx1 * w)), Math.min(h - 1, Math.ceil(fy1 * h)));
  }
  function rowBands(mask, w, h) {
    var rows = new Array(h), maxRow = 0, y, x;
    for (y = 0; y < h; y++) { var c = 0; for (x = 0; x < w; x++) c += mask[y * w + x]; rows[y] = c; if (c > maxRow) maxRow = c; }
    // Adaptive: a row is "on" only if its ink is a real fraction of the busiest
    // row, so a couple of edge/felt pixels don't fill the gap between rank & suit.
    var onThr = Math.max(2, maxRow * 0.3), bands = [], run = null;
    for (y = 0; y < h; y++) {
      var on = rows[y] >= onThr;
      if (on) { if (!run) run = { y0: y, y1: y }; else run.y1 = y; }
      else if (run) { bands.push(run); run = null; }
    }
    if (run) bands.push(run);
    return bands;
  }
  function colBounds(mask, w, y0, y1) {
    var x0 = w, x1 = -1;
    for (var x = 0; x < w; x++) for (var y = y0; y <= y1; y++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; break; }
    if (x1 < 0) { x0 = 0; x1 = w - 1; }
    return { x0: x0, x1: x1 };
  }
  function matchKind(sig, kind, useColor) {
    var best = null, bs = 1e9;
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      if (t.kind !== kind) continue;
      var s = rms(t.vec, sig.vec) + (useColor ? 1.0 * Math.abs((t.red || 0) - sig.red) : 0);
      if (s < bs) { bs = s; best = t; }
    }
    return (best && bs < (kind === "suit" ? sthr : gthr)) ? best.label : null;
  }
  // Returns {status:'empty'|'card'|'unknown', id?, label?, teach?, img?, sig?}
  function recognizeCard(regionImg) {
    var whole = signature(regionImg);
    if (!(whole.white > 0.1 || whole.red > 0.05)) return { status: "empty" };

    var corner = subImage(regionImg, CORNER.x0, CORNER.y0, CORNER.x1, CORNER.y1);
    var cw = corner.width, ch = corner.height;
    var mask = inkMask(corner, estimateBg(corner));
    var bands = rowBands(mask, cw, ch);
    if (!bands.length) return { status: "unknown" };

    var rankBand = bands[0];
    var suitBand = bands.length >= 2 ? bands[bands.length - 1] : null;

    var rcb = colBounds(mask, cw, rankBand.y0, rankBand.y1);
    var rankImg = cropRect(corner, rcb.x0, rankBand.y0, rcb.x1, rankBand.y1);
    var rankSig = { vec: glyphVec(mask, cw, rcb.x0, rankBand.y0, rcb.x1, rankBand.y1), red: 0 };
    var rank = matchKind(rankSig, "rank", false);
    if (!rank) {
      if (isIgnored(rankSig, "rank")) return { status: "unknown" };
      return { status: "unknown", teach: "rank", img: rankImg, sig: rankSig };
    }

    if (!suitBand) return { status: "unknown", teach: "suit", img: rankImg, sig: rankSig };
    var scb = colBounds(mask, cw, suitBand.y0, suitBand.y1);
    var suitImg = cropRect(corner, scb.x0, suitBand.y0, scb.x1, suitBand.y1);
    var suitSig = { vec: glyphVec(mask, cw, scb.x0, suitBand.y0, scb.x1, suitBand.y1), red: boxColor(corner, scb.x0, suitBand.y0, scb.x1, suitBand.y1).red };
    var suit = matchKind(suitSig, "suit", true);
    if (!suit) {
      if (isIgnored(suitSig, "suit")) return { status: "unknown" };
      return { status: "unknown", teach: "suit", img: suitImg, sig: suitSig };
    }
    return { status: "card", id: Poker.makeId(RANK_VAL[rank], SUIT_CODE[suit]), label: rank + suit };
  }

  function isIgnored(sig, kind) {
    for (var i = 0; i < ignored.length; i++) {
      if (ignored[i].kind === kind && rms(ignored[i].vec, sig.vec) < gthr) return true;
    }
    return false;
  }

  // ---------- Capture plumbing ----------
  var stream = null, video = null, work = null, wctx = null;
  var watching = false, tickTimer = null, fps = 3;

  function stopStream() {
    watching = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (el.dock) el.dock.hidden = true;
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
      var res = recognizeCard(img);
      var val = res.status === "card" ? "card:" + res.label : res.status + (res.teach ? ":" + res.teach : "");
      var st = stab[key];
      if (st && st.val === val) st.count++;
      else stab[key] = st = { val: val, count: 1 };
      st.res = res;
      if (st.count >= 2) {
        if (res.status === "card") setSlot(reading, key, res.id);
        else if (res.status === "empty") setSlot(reading, key, null);
        // 'unknown' -> leave the manual value alone; queue a glyph to teach
        if (res.status === "unknown" && res.teach) unknowns.push({ key: key, kind: res.teach, img: res.img, sig: res.sig });
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
    var stage = h("div", "watch-stage"); el.stage = stage;
    video = document.createElement("video"); video.muted = true; video.playsInline = true; video.autoplay = true; video.className = "watch-video";
    el.canvas = document.createElement("canvas"); el.canvas.className = "watch-canvas";
    // Offscreen canvas used to pull pixels from the current video frame.
    work = document.createElement("canvas");
    wctx = work.getContext("2d", { willReadFrequently: true });
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
    clear.appendChild(mkbtn("Forget taught cards", function () {
      templates = []; ignored = []; saveJSON(LS_TEMPLATES, templates); saveJSON(LS_IGNORE, ignored);
      setStatus("Taught glyphs + skips cleared.");
    }));
    settings.appendChild(clear);
    modal.appendChild(settings);

    modal.appendChild(h("p", "watch-note",
      "One-time setup per site: drag a box over each of your two cards, the five board spots, " +
      "and (optional) the Pot and My-stack numbers. It reads the corner rank + suit, so you only " +
      "teach ~17 glyphs once (13 ranks + 4 suits), not every card. Tip: zoom the poker window " +
      "(Ctrl/Cmd +) so the cards are bigger - accuracy improves a lot. Close with ✕ and it keeps " +
      "watching from a small dock. Any misread card can be fixed with one tap on the table."));

    el.overlay = overlay;
    document.body.appendChild(overlay);

    // Persistent live dock: when the panel is closed mid-watch the <video> is
    // moved here so it stays visibly rendered (a hidden video stops decoding).
    var dock = h("div", "watch-dock"); dock.hidden = true; el.dock = dock;
    var dockHead = h("div", "watch-dock-head");
    dockHead.appendChild(h("span", null, "<span class='dot'></span> Watching"));
    var dockBtns = h("div", "watch-dock-btns");
    dockBtns.appendChild(mkbtn("Expand", openModal));
    dockBtns.appendChild(mkbtn("Stop", stopStream));
    dockHead.appendChild(dockBtns);
    dock.appendChild(dockHead);
    el.dockVideo = h("div", "watch-dock-video");
    dock.appendChild(el.dockVideo);
    el.dockStrip = h("div", "watch-strip watch-dock-strip");
    dock.appendChild(el.dockStrip);
    document.body.appendChild(dock);

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
    // Controls the glyph match distance (gthr). Lower = stricter (fewer wrong
    // reads, more "teach" prompts); higher = looser.
    var s = document.createElement("input"); s.type = "range"; s.min = 8; s.max = 30; s.value = Math.round(gthr * 100);
    s.addEventListener("input", function () { gthr = +s.value / 100; });
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
    if (el.dockStrip) el.dockStrip.innerHTML = el.strip.innerHTML; // mirror into the dock
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
    var kind = teaching.kind; // 'rank' | 'suit' | 'digit'
    var titles = { rank: "the rank (corner number/letter)", suit: "the suit shape", digit: "a digit" };
    el.teach.appendChild(h("div", "teach-title",
      "Unrecognised " + (titles[kind] || "glyph") + " in " + REGION_LABELS[teaching.key] +
      " — tap what it is (just once each):"));
    var body = h("div", "teach-body");
    var thumb = h("canvas", "teach-thumb");
    thumb.width = teaching.img.width; thumb.height = teaching.img.height;
    thumb.getContext("2d").putImageData(teaching.img, 0, 0);
    body.appendChild(thumb);

    var grid = h("div", "teach-grid " + kind);
    if (kind === "digit") {
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "K", "M"].forEach(function (g) {
        var btn = h("button", "teach-pick", g);
        btn.title = (g === "K" ? "thousands (K)" : g === "M" ? "millions (M)" : "");
        btn.addEventListener("click", function () { teachAs(g, "digit"); });
        grid.appendChild(btn);
      });
    } else if (kind === "suit") {
      [["s", "♠", "black"], ["h", "♥", "red"], ["d", "♦", "red"], ["c", "♣", "black"]].forEach(function (s) {
        var btn = h("button", "teach-pick " + s[2], s[1]);
        btn.addEventListener("click", function () { teachAs(s[0], "suit"); });
        grid.appendChild(btn);
      });
    } else { // rank
      ["A", "K", "Q", "J", "10", "9", "8", "7", "6", "5", "4", "3", "2"].forEach(function (rk) {
        var btn = h("button", "teach-pick", rk);
        btn.addEventListener("click", function () { teachAs(rk, "rank"); });
        grid.appendChild(btn);
      });
    }
    body.appendChild(grid);
    el.teach.appendChild(body);

    var extra = h("div", "teach-extra");
    extra.appendChild(mkbtn("Skip (ignore this)", function () {
      // Remember the skipped shape so it never re-prompts until you clear it.
      ignored.push({ kind: teaching.kind, red: teaching.sig.red, vec: Array.prototype.slice.call(teaching.sig.vec) });
      saveJSON(LS_IGNORE, ignored);
      teaching = null; el.teach.hidden = true;
    }));
    el.teach.appendChild(extra);
  }
  function teachAs(label, kind) {
    if (!teaching) return;
    templates.push({ label: label, kind: kind, red: teaching.sig.red, vec: Array.prototype.slice.call(teaching.sig.vec) });
    saveJSON(LS_TEMPLATES, templates);
    stab[teaching.key] = null; // force re-evaluate
    teaching = null;
    setStatus("Learned it — recognised automatically from now on.");
  }

  // ---------- open / close ----------
  // A hidden <video> stops decoding, so when the panel is closed mid-watch we
  // move the live <video> into a small always-visible dock; the single stream
  // keeps playing across the DOM move so the recogniser keeps getting frames.
  function openModal() {
    if (!el.overlay) buildModal();
    if (video && el.stage && video.parentNode !== el.stage) {
      el.stage.insertBefore(video, el.canvas); // put the live video back in the panel
    }
    if (el.dock) el.dock.hidden = true;
    el.overlay.hidden = false;
    if (SUPPORTED) { requestAnimationFrame(drawOverlay); }
  }
  function closeModal() {
    if (!el.overlay) return;
    if (SUPPORTED && watching && stream) {
      // Keep capturing: dock the live video (still visibly rendered).
      if (video && el.dockVideo && video.parentNode !== el.dockVideo) el.dockVideo.appendChild(video);
      el.dock.hidden = false;
      el.overlay.hidden = true;
    } else {
      if (el.dock) el.dock.hidden = true;
      el.overlay.hidden = true;
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
    _recognizeCard: recognizeCard, _ignored: function () { return ignored; },
    _cardParts: function (regionImg) {
      var corner = subImage(regionImg, CORNER.x0, CORNER.y0, CORNER.x1, CORNER.y1);
      var mask = inkMask(corner, estimateBg(corner));
      var bands = rowBands(mask, corner.width, corner.height);
      return { cornerW: corner.width, cornerH: corner.height, bands: bands.map(function (b) { return [b.y0, b.y1]; }) };
    },
    _teach: function (label, sig, kind) { templates.push({ label: label, kind: kind || "card", red: sig.red, vec: Array.prototype.slice.call(sig.vec) }); },
    _regions: function () { return regions; }, _templates: function () { return templates; },
    _setWatching: function (v) { watching = v; }, _open: openModal, _close: closeModal,
    _useStream: function (s) { if (!el.overlay) buildModal(); stream = s; video.srcObject = s; video.play(); },
    _start: startWatching, _videoParent: function () { return video && video.parentNode ? video.parentNode.className : null; },
  };
})();
