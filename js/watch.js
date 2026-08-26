/*
 * watch.js - "Watch mode": read a shared browser tab/window live and feed the
 * recognised cards into the Poker Assistant, so you don't type them by hand.
 *
 * How it works
 * ------------
 * 1. You share a tab or window with the Screen Capture API (getDisplayMedia).
 *    This can be a DIFFERENT site than this app - the browser streams its
 *    pixels to us and, because you consented, we can read them off a canvas.
 * 2. You calibrate once: trace a box around each of your two hole cards and the
 *    five board positions - one straight edge at a time, clicking the first
 *    point again to close. Boxes are saved (normalised) in localStorage, and the
 *    whole 52-card deck is recognised from a built-in database (js/carddb.js)
 *    with no teaching needed.
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
  // Seat "presence" regions - one spot per OPPONENT seat (up to 6, since you're
  // the 7th). Each reads as empty (the plus-sign), in the hand (a full-opacity
  // avatar) or folded (a faded, low-opacity avatar) - taught from real examples.
  var SEAT_KEYS = ["s0", "s1", "s2", "s3", "s4", "s5"];
  var MAX_SEATS = 6;          // opponent seats you can place
  var MAX_PLAYERS = 7;        // opponents + you
  var ALL_KEYS = REGION_KEYS.concat(NUM_KEYS, SEAT_KEYS);
  var REGION_LABELS = {
    hero0: "Your card 1", hero1: "Your card 2",
    b0: "Flop 1", b1: "Flop 2", b2: "Flop 3", b3: "Turn", b4: "River",
    pot: "Pot (number)", mystack: "My stack (number)",
    s0: "Seat 1", s1: "Seat 2", s2: "Seat 3", s3: "Seat 4", s4: "Seat 5", s5: "Seat 6",
  };

  // ---------- Persistence ----------
  var LS_REGIONS = "pokerwatch.regions.v1";
  var LS_TEMPLATES = "pokerwatch.templates.v2"; // v2: rank/suit/digit glyphs
  var LS_IGNORE = "pokerwatch.ignore.v1";
  var LS_SEATSTATES = "pokerwatch.seatstates.v1"; // taught seat looks
  var LS_SEATCOUNT = "pokerwatch.seatcount.v1";   // how many opponent seats to watch
  function loadJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var regions = loadJSON(LS_REGIONS, {});     // key -> {x,y,w,h} or {poly,x,y,w,h} normalised
  var templates = loadJSON(LS_TEMPLATES, []); // user-taught: [{kind, label, red, vec:[...]}]
  var ignored = loadJSON(LS_IGNORE, []);      // skipped glyph signatures (won't re-prompt)
  // Taught seat looks: exemplars of each state. empty keeps a signature (the
  // plus-sign is a fixed shape) + vibrancy; folded/active keep vibrancy (opacity)
  // so they generalise across different player avatars.
  var seatStates = loadJSON(LS_SEATSTATES, { empty: [], folded: [], active: [] });
  var seatCount = loadJSON(LS_SEATCOUNT, 5);  // opponents to watch (1..6)

  // Built-in card database (js/carddb.js): rank + suit glyph exemplars taken
  // from the real site's card art, so the whole deck is recognised out of the
  // box - no teaching needed. Bit-packed vectors are unpacked once here. User
  // teaches (above) are searched alongside these and always win ties, so you can
  // still correct any card and it sticks.
  var dbTemplates = (function () {
    var db = window.PokerCardDB;
    if (!db || !db.templates || !db.templates.length) return [];
    // Greyscale coverage, one byte (0..255 -> 0..1) per cell, base64-encoded.
    function unpack(b64, n) {
      var bin = atob(b64), vec = new Float32Array(n);
      for (var i = 0; i < n; i++) vec[i] = bin.charCodeAt(i) / 255;
      return vec;
    }
    return db.templates.map(function (t) {
      return { label: t.label, kind: t.kind, red: t.red, vec: unpack(t.bits, t.n), db: true };
    });
  })();

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
  // Mean colour "vibrancy" (saturation) of a region, 0..1. A full-opacity player
  // avatar is vivid; a folded avatar is faded (blended with felt) and an empty
  // seat is a flat plus-sign - so vibrancy separates an in-hand player from a
  // folded one.
  function regionVibrancy(img) {
    var d = img.data, n = 0, sat = 0;
    for (var i = 0; i < d.length; i += 4) {
      var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      sat += (mx - mn); n++;
    }
    return n ? (sat / n) / 255 : 0;
  }
  var occThr = 0.55;                          // empty plus-sign template match distance
  function seatMeanVib(list) { if (!list.length) return null; var s = 0; for (var i = 0; i < list.length; i++) s += list[i].vib; return s / list.length; }
  // Classify a seat as 'empty' / 'folded' / 'active' against the looks you've
  // taught. Empty is matched by the plus-sign SIGNATURE (a fixed shape); folded
  // and in-hand are told apart by VIBRANCY (opacity), which generalises across
  // different player avatars. Returns null while nothing has been taught yet.
  function classifySeat(sig, vib) {
    var e = seatStates.empty, f = seatStates.folded, a = seatStates.active;
    if (e.length) {                                   // strong empty check by plus-sign shape
      var best = Infinity;
      for (var i = 0; i < e.length; i++) if (e[i].vec) { var dd = rms(e[i].vec, sig.vec); if (dd < best) best = dd; }
      if (best < occThr) return "empty";
    }
    var opts = [], eV = seatMeanVib(e), fV = seatMeanVib(f), aV = seatMeanVib(a);
    if (eV != null) opts.push(["empty", Math.abs(vib - eV)]);
    if (fV != null) opts.push(["folded", Math.abs(vib - fV)]);
    if (aV != null) opts.push(["active", Math.abs(vib - aV)]);
    if (!opts.length) return null;                    // untrained
    opts.sort(function (x, y) { return x[1] - y[1]; });
    return opts[0][0];
  }

  // A higher-resolution GREYSCALE "ink-shape" descriptor for matching individual
  // glyphs (ranks / suits / digits). Each cell holds the ink COVERAGE fraction
  // (0..1), not a 1-bit on/off - the extra tonal detail is what lets it tell a
  // heart from a diamond, or a 5 from a 6/8, at the tiny sizes an index shows.
  // Built from a mask computed on the image WITH background (a tight glyph crop
  // has no background to threshold).
  var GW = 24, GH = 36;
  function glyphVec(mask, w, x0, y0, x1, y1) {
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1, vec = new Float32Array(GW * GH);
    for (var ty = 0; ty < GH; ty++) for (var tx = 0; tx < GW; tx++) {
      var cx0 = x0 + ((tx * bw / GW) | 0), cx1 = Math.max(cx0 + 1, x0 + (((tx + 1) * bw / GW) | 0));
      var cy0 = y0 + ((ty * bh / GH) | 0), cy1 = Math.max(cy0 + 1, y0 + (((ty + 1) * bh / GH) | 0));
      var c = 0, n = 0;
      for (var y = cy0; y < cy1; y++) for (var x = cx0; x < cx1; x++) { c += mask[y * w + x]; n++; }
      vec[ty * GW + tx] = c / (n || 1);
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
  var gthr = 0.42;       // digit match distance (must absorb red-vs-black edge noise)
  var sthr = 0.32;       // (legacy) suit distance for the taught-only path
  // Card rank/suit accept distances. The built-in DB has one exemplar per card,
  // so the true card is reliably the NEAREST; these bounds are looser (they only
  // reject non-glyphs) because live crops of the same art differ a bit from the
  // reference through anti-aliasing, scaling and how the box was drawn. The ink
  // guard + "is a card present" check stop empty/felt regions matching anything.
  var rankThr = 0.50;
  var suitThr = 0.62;

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
  // Binary ink mask of ONLY the card's red + black marks. A pixel is "ink" if it
  // is red (red channel dominant) or stands out from the background in luminance
  // (black glyph on white, or a light digit on a dark panel) - but GREEN felt is
  // explicitly excluded, so the table background is ignored even when a crop
  // includes it or has snipped card edges. A red glyph and a black glyph produce
  // the same shape mask, so ranks match across suit colours.
  function inkMask(img, bg) {
    var w = img.width, h = img.height, d = img.data, m = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      var isRed = (r - g > 40 && r - b > 40 && r > 80);
      var isGreen = (g - r > 22 && g - b > 12);            // table felt
      var isContrast = Math.abs(lum - bg) > 55;             // dark glyph / light digit
      m[y * w + x] = ((isRed || isContrast) && !isGreen) ? 1 : 0;
    }
    return m;
  }
  // Segment ink columns into glyph x-ranges.
  function segmentGlyphs(mask, w, h) {
    // Low threshold so a small decimal point / comma still registers as its own
    // column (otherwise 1.2M loses the dot and reads as 12M).
    var onThr = Math.max(1, h * 0.03), glyphs = [], run = null;
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
    var m = nearestKind(sig, "digit", false);
    return (m && m.dist < gthr) ? m.label : null;
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
  // Merge bands separated by only a tiny vertical gap (a thin part of one glyph,
  // e.g. the waist of an A) so a single rank isn't split into rank + fake suit.
  function mergeBands(bands) {
    if (bands.length < 2) return bands;
    var out = [bands[0]];
    for (var i = 1; i < bands.length; i++) {
      var prev = out[out.length - 1], cur = bands[i];
      var gap = cur.y0 - prev.y1 - 1;
      var hh = Math.max(prev.y1 - prev.y0, cur.y1 - cur.y0) + 1;
      if (gap <= Math.max(1, hh * 0.18)) prev.y1 = cur.y1; // same glyph
      else out.push(cur);
    }
    return out;
  }
  function colBounds(mask, w, y0, y1) {
    var x0 = w, x1 = -1;
    for (var x = 0; x < w; x++) for (var y = y0; y <= y1; y++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; break; }
    if (x1 < 0) { x0 = 0; x1 = w - 1; }
    return { x0: x0, x1: x1 };
  }
  // Nearest-neighbour over BOTH the built-in card DB and any user-taught glyphs.
  // Returns {label, dist} of the closest exemplar of this kind (or null).
  function nearestKind(sig, kind, useColor) {
    var best = null, bs = 1e9;
    function scan(list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.kind !== kind) continue;
        var s = rms(t.vec, sig.vec) + (useColor ? 1.0 * Math.abs((t.red || 0) - sig.red) : 0);
        if (s < bs) { bs = s; best = t; }
      }
    }
    scan(dbTemplates); scan(templates);   // user teaches scanned last -> win ties
    return best ? { label: best.label, dist: bs } : null;
  }
  function matchKind(sig, kind, useColor) {
    var m = nearestKind(sig, kind, useColor);
    return (m && m.dist < (kind === "suit" ? sthr : gthr)) ? m.label : null;
  }
  // Suit match anchored on COLOUR. Red vs black is a rock-solid signal, so we
  // first decide the colour from the suit's red fraction, then pick the nearer
  // of only the TWO suits of that colour by shape. This 2-way decision is far
  // more robust for the tiny corner suit than a 4-way shape match with a tight
  // threshold - which is what lets a mostly-hidden card read from its little
  // index suit alone. Returns {label, dist, red}.
  function nearestSuit(sig) {
    var isRed = (sig.red || 0) > 0.14;
    var minByLabel = {};                                  // best distance per suit label
    function scan(list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (t.kind !== "suit") continue;
        if (((t.red || 0) > 0.14) !== isRed) continue;   // only same-colour exemplars
        var s = rms(t.vec, sig.vec);
        if (!(t.label in minByLabel) || s < minByLabel[t.label]) minByLabel[t.label] = s;
      }
    }
    scan(dbTemplates); scan(templates);
    var labels = Object.keys(minByLabel);
    if (!labels.length) return null;
    labels.sort(function (a, b) { return minByLabel[a] - minByLabel[b]; });
    var best = labels[0], bd = minByLabel[best];
    var second = labels.length > 1 ? minByLabel[labels[1]] : Infinity;
    // margin = how much better the winner is than the other same-colour suit;
    // a tiny margin means heart/diamond (or spade/club) are too close to call.
    return { label: best, dist: bd, red: isRed, margin: second - bd };
  }
  // Any ink found strictly below a y line (used to locate a small/faint suit pip
  // that didn't clear the row-band threshold). Ignores stray single pixels.
  function rawInkBelow(mask, w, h, yStart) {
    var y0 = h, y1 = -1, total = 0;
    for (var y = yStart + 1; y < h; y++) {
      var rowc = 0;
      for (var x = 0; x < w; x++) if (mask[y * w + x]) { rowc++; }
      if (rowc) { if (y < y0) y0 = y; if (y > y1) y1 = y; total += rowc; }
    }
    if (y1 < 0 || total < 3) return null;
    return { y0: y0, y1: y1 };
  }
  // Bounding box of all red/black ink in an image (green felt excluded), or null.
  function inkBBox(img) {
    var mask = inkMask(img, estimateBg(img)), w = img.width, h = img.height;
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (mask[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  // Trim a card region down to just its printed marks (rank + suits), so felt
  // padding, blank card margins and snipped edges don't shift where the index
  // sits. This makes recognition independent of how tightly the box was drawn.
  function normalizeCard(img) {
    var bb = inkBBox(img);
    if (!bb) return img;
    var mx = Math.round((bb.x1 - bb.x0) * 0.06) + 1, my = Math.round((bb.y1 - bb.y0) * 0.06) + 1;
    return cropRect(img,
      Math.max(0, bb.x0 - mx), Math.max(0, bb.y0 - my),
      Math.min(img.width - 1, bb.x1 + mx), Math.min(img.height - 1, bb.y1 + my));
  }
  // Contiguous horizontal ink bands (row runs with ink >= onThr).
  function inkRowBands(mask, cw, ch, onThr) {
    var bands = [], run = null;
    for (var y = 0; y < ch; y++) {
      var c = 0; for (var x = 0; x < cw; x++) c += mask[y * cw + x];
      if (c >= onThr) { if (!run) run = { y0: y, y1: y }; else run.y1 = y; }
      else if (run) { bands.push(run); run = null; }
    }
    if (run) bands.push(run);
    return bands;
  }
  // Column clusters with ink in rows [y0,y1]; clusters separated by only a small
  // gap (e.g. the "1" and "0" of a 10) are merged into one.
  function colClusters(mask, cw, y0, y1) {
    var on = new Array(cw), x, y;
    for (x = 0; x < cw; x++) { on[x] = 0; for (y = y0; y <= y1; y++) if (mask[y * cw + x]) { on[x] = 1; break; } }
    var runs = [], run = null;
    for (x = 0; x < cw; x++) { if (on[x]) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; } else if (run) { runs.push(run); run = null; } }
    if (run) runs.push(run);
    var gap = Math.max(2, Math.round((y1 - y0 + 1) * 0.45)), out = [];
    runs.forEach(function (r) { var p = out[out.length - 1]; if (p && r.x0 - p.x1 - 1 <= gap) p.x1 = r.x1; else out.push({ x0: r.x0, x1: r.x1 }); });
    return out;
  }
  // Split a card region into the NUMBER (top-left) and the small SUIT DIRECTLY
  // UNDER IT. The suit is searched only in the number's own column, so the big
  // central suit symbol (which is to the right) is ignored - this is what lets a
  // card that's mostly hidden behind another still read from just its visible
  // top-left index. If nothing sits under the number, the box is cut off (`cut`).
  function segmentCard(img) {
    var cw = img.width, ch = img.height, y, x;
    var mask = inkMask(img, estimateBg(img));
    var maxRow = 0;
    for (y = 0; y < ch; y++) { var c = 0; for (x = 0; x < cw; x++) c += mask[y * cw + x]; if (c > maxRow) maxRow = c; }
    if (maxRow === 0) return null;
    var bands = inkRowBands(mask, cw, ch, Math.max(1, maxRow * 0.08));
    if (!bands.length) return null;
    var rankBand = bands[0];                                  // number sits in the top band
    var clusters = colClusters(mask, cw, rankBand.y0, rankBand.y1);
    if (!clusters.length) return null;
    var num = clusters[0];                                    // leftmost cluster = the number
    var nx0 = num.x0, nx1 = num.x1, nw = nx1 - nx0 + 1;
    var out = {
      rankImg: cropRect(img, nx0, rankBand.y0, nx1, rankBand.y1),
      rankSig: { vec: glyphVec(mask, cw, nx0, rankBand.y0, nx1, rankBand.y1), red: 0 },
    };
    // Suit = the first ink DIRECTLY UNDER the number, found inside a NARROW
    // column strip around the number's own columns. The big central suit symbol
    // sits to the right of that strip, so it is excluded outright - which is what
    // lets a card that's mostly hidden read from just its top-left index.
    var stripLo = Math.max(0, Math.round(nx0 - nw * 0.2)), stripHi = Math.min(cw - 1, Math.round(nx1 + nw * 0.2));
    var suit = null, syA = -1, syB = -1;
    for (y = rankBand.y1 + 1; y < ch; y++) {
      var rc = 0; for (x = stripLo; x <= stripHi; x++) if (mask[y * cw + x]) rc++;
      if (rc >= 1) { if (syA < 0) syA = y; syB = y; }
      else if (syA >= 0) break;                              // first gap after the small suit
    }
    if (syA >= 0 && syB - syA >= 1) {
      var qx0 = stripHi, qx1 = stripLo;
      for (y = syA; y <= syB; y++) for (x = stripLo; x <= stripHi; x++) if (mask[y * cw + x]) { if (x < qx0) qx0 = x; if (x > qx1) qx1 = x; }
      if (qx1 >= qx0) suit = { x0: qx0, x1: qx1, y0: syA, y1: syB };
    }
    if (suit) {
      out.suitImg = cropRect(img, suit.x0, suit.y0, suit.x1, suit.y1);
      out.suitSig = { vec: glyphVec(mask, cw, suit.x0, suit.y0, suit.x1, suit.y1), red: boxColor(img, suit.x0, suit.y0, suit.x1, suit.y1).red };
    } else {
      out.cut = true; // nothing under the number -> suit isn't in the crop
      var sy0c = Math.min(ch - 1, rankBand.y1 + 1);
      out.suitImg = cropRect(img, 0, sy0c, cw - 1, ch - 1);
    }
    return out;
  }
  var EMPTY_SIG = { vec: new Float32Array(GW * GH), red: 0 };
  // A glyph descriptor is only usable if a sensible fraction of it is ink. A
  // near-blank crop (a sliver of a card, felt, a gap) has almost no ink and, left
  // unguarded, rms-matches sparse exemplars at ~0 distance - a false positive.
  function validInk(sig) {
    if (!sig || !sig.vec) return false;
    var s = 0, v = sig.vec; for (var i = 0; i < v.length; i++) s += v[i];
    var f = s / v.length;
    return f >= 0.05 && f <= 0.9;
  }
  // Score one candidate crop into {seg, r, s} where r/s are nearest rank/suit
  // matches (only when the glyph passes the ink guard).
  function scoreCrop(img) {
    var seg = segmentCard(img);
    if (!seg) return null;
    var r = validInk(seg.rankSig) ? nearestKind(seg.rankSig, "rank", false) : null;
    var s = (seg.suitSig && validInk(seg.suitSig)) ? nearestSuit(seg.suitSig) : null;
    return { seg: seg, r: r, s: s };
  }
  // Recognise a card region against the built-in DB (+ user teaches). Tries both
  // the top-left corner (a FULL card - isolates the index from the central pips)
  // and the whole box (a tight index box, e.g. a card slid behind another), and
  // keeps whichever gives the best rank+suit match. Focuses on the red/black
  // index ink; the green felt and blank areas fall out via the bg/ink masking.
  // Returns {status:'empty'|'card'|'unknown', id?, label?, teach?, img?, sig?}
  function recognizeCard(regionImg) {
    var whole = signature(regionImg);
    if (!(whole.white > 0.1 || whole.red > 0.05)) return { status: "empty" };
    // Trim to the actual marks so felt/margins/snipped edges don't move the
    // index, then read the left-column index (rank over the small suit) from the
    // corner, and also try the whole trimmed card.
    var card = normalizeCard(regionImg);
    var cands = [
      scoreCrop(subImage(card, CORNER.x0, CORNER.y0, CORNER.x1, CORNER.y1)),
      scoreCrop(card),
    ];
    // Best complete read: both rank and suit under threshold, lowest total dist.
    var best = null;
    cands.forEach(function (c) {
      if (!c || !c.r || !c.s) return;
      // Require the suit's colour-mates to be distinguishable (margin): if a
      // heart and a diamond are almost equally close, don't guess - ask instead.
      if (c.r.dist < rankThr && c.s.dist < suitThr && (c.s.margin === undefined || c.s.margin >= 0.02)) {
        var tot = c.r.dist + c.s.dist;
        if (!best || tot < best.tot) best = { tot: tot, r: c.r, s: c.s };
      }
    });
    if (best) return { status: "card", id: Poker.makeId(RANK_VAL[best.r.label], SUIT_CODE[best.s.label]), label: best.r.label + best.s.label };
    // No complete read - produce a teach prompt from the most-progressed crop
    // (prefer one whose rank already matched, so the next question is the suit).
    var tc = null;
    cands.forEach(function (c) {
      if (!c || !c.seg) return;
      if (!tc) { tc = c; return; }
      var cR = c.r && c.r.dist < rankThr, tR = tc.r && tc.r.dist < rankThr;
      if (cR && !tR) tc = c;
    });
    if (!tc) return { status: "unknown" };
    var seg = tc.seg;
    if (!(tc.r && tc.r.dist < rankThr)) {              // rank not known yet
      if (!validInk(seg.rankSig) || isIgnored(seg.rankSig, "rank")) return { status: "unknown" };
      return { status: "unknown", teach: "rank", img: seg.rankImg, sig: seg.rankSig };
    }
    if (seg.cut || !seg.suitSig || !validInk(seg.suitSig))   // rank known, suit missing/cut
      return { status: "unknown", teach: "suit", cut: !!seg.cut, img: seg.suitImg, sig: seg.suitSig || EMPTY_SIG };
    if (isIgnored(seg.suitSig, "suit")) return { status: "unknown" };
    return { status: "unknown", teach: "suit", img: seg.suitImg, sig: seg.suitSig };
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
    var img = wctx.getImageData(x, y, w, h);
    if (rect.poly && rect.poly.length >= 3) maskOutsidePoly(img, rect.poly, rect, w, h);
    return img;
  }
  // Point-in-polygon (ray cast) with the polygon given in the region's own
  // normalised [0..1] coordinates.
  function pointInPoly(px, py, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  // Replace everything OUTSIDE the traced polygon with the median colour of the
  // pixels inside it, so a neighbouring card's ink or the felt can't leak into
  // the read - only what you traced is considered.
  function maskOutsidePoly(img, poly, rect, w, h) {
    var d = img.data;
    // poly points are normalised to the whole frame; convert to this crop's px.
    var pts = poly.map(function (p) { return { x: (p.x - rect.x) / rect.w, y: (p.y - rect.y) / rect.h }; });
    // Fill colour = the card BODY colour (bright, low-saturation pixels inside
    // the trace), so replacing the outside keeps the white background the ink
    // mask expects - filling with a felt/card average would shift it and thin
    // the glyphs. Fall back to the overall inside median if no body is found.
    var body = [], all = [], x, y, i, r, g, bl, lum, sat;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!pointInPoly((x + 0.5) / w, (y + 0.5) / h, pts)) continue;
      i = (y * w + x) * 4; r = d[i]; g = d[i + 1]; bl = d[i + 2];
      lum = 0.299 * r + 0.587 * g + 0.114 * bl; sat = Math.max(r, g, bl) - Math.min(r, g, bl);
      all.push(lum);
      if (lum > 170 && sat < 40) body.push([r, g, bl]);
    }
    if (!all.length) return;
    var fr, fg, fb;
    if (body.length >= 8) {
      body.sort(function (p, q) { return (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2]); });
      var m = body[body.length >> 1]; fr = m[0]; fg = m[1]; fb = m[2];
    } else { all.sort(function (p, q) { return p - q; }); fr = fg = fb = all[all.length >> 1]; }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!pointInPoly((x + 0.5) / w, (y + 0.5) / h, pts)) { i = (y * w + x) * 4; d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; }
    }
  }

  // ---------- Watch loop ----------
  var stab = {}; // key -> { val, count, sig }
  var teachSuppressed = {}; // key -> the reading value that was skipped/re-boxed
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
      st.cardImg = img; // kept so a manual correction can teach from this frame
      // A skip/re-box suppresses re-prompting for this region until what it sees
      // actually changes (so the panel stops popping back over you every frame).
      if (teachSuppressed[key] !== undefined && teachSuppressed[key] !== val) delete teachSuppressed[key];
      if (st.count >= 2) {
        if (res.status === "card") { setSlot(reading, key, res.id); delete teachSuppressed[key]; }
        else if (res.status === "empty") { setSlot(reading, key, null); delete teachSuppressed[key]; }
        // 'unknown' -> leave the manual value alone; queue a glyph to teach, unless
        // this region is being re-boxed right now or was just skipped.
        var busy = teachSuppressed[key] !== undefined || (calibrating && selectedKey === key);
        if (res.status === "unknown" && res.teach && !busy) unknowns.push({ key: key, kind: res.teach, img: res.img, sig: res.sig, cut: res.cut });
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
    // Seat state: over the first `seatCount` OPPONENT seats, each boxed seat is
    // classified empty / folded / in-hand against the looks you've taught. Only
    // in-hand opponents (+ you) count toward the odds. Runs once you've boxed at
    // least one seat; the seat-count input alone sets the number directly.
    if (SEAT_KEYS.some(function (k) { return regions[k]; })) {
      var activeOpp = 0;
      for (var si = 0; si < seatCount; si++) {
        var key = SEAT_KEYS[si];
        if (!regions[key]) { activeOpp++; continue; }        // seat not boxed -> assume a player is there
        var img = regionImageData(regions[key]);
        var sig = signature(img), vib = regionVibrancy(img);
        var state = classifySeat(sig, vib) || "active";       // untrained -> assume in
        var st = stab[key], val = "seat:" + state;
        if (st && st.val === val) st.count++; else stab[key] = st = { val: val, count: 1 };
        st.state = state; st.sig = sig; st.vib = vib;
        var inHand = st.count >= 2 ? (state === "active") : true;  // assume active during warm-up
        if (inHand) activeOpp++;
      }
      var n = Math.max(2, Math.min(MAX_PLAYERS, activeOpp + 1)); // + you
      var cst = stab.__seatcount, cval = "n:" + n;
      if (cst && cst.val === cval) cst.count++; else stab.__seatcount = cst = { val: cval, count: 1 };
      if (cst.count >= 2) reading.numPlayers = n;
    }
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
  var polyPts = null, polyHover = null; // in-progress trace: points + cursor (canvas px)
  var CLOSE_PX = 12;                    // max snap distance to the first point to close
  // Snap radius (squared) for closing the trace onto its start point. It shrinks
  // for small boxes - to at most ~35% of the shortest edge drawn so far - so the
  // adjacent corners of a small area don't snap the box shut before you finish.
  function closeR2() {
    var base = CLOSE_PX;
    if (polyPts && polyPts.length >= 2) {
      var minEdge = Infinity;
      for (var i = 1; i < polyPts.length; i++) { var d = Math.sqrt(dist2(polyPts[i], polyPts[i - 1])); if (d < minEdge) minEdge = d; }
      base = Math.max(4, Math.min(CLOSE_PX, minEdge * 0.35));
    }
    return base * base;
  }

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
    // Magnifier loupe: a zoomed view under the cursor while you draw a box, so
    // you can place the edges precisely even on small cards.
    el.loupe = document.createElement("canvas"); el.loupe.className = "watch-loupe"; el.loupe.hidden = true;
    el.loupe.width = 132; el.loupe.height = 132;
    stage.appendChild(video); stage.appendChild(el.canvas); stage.appendChild(el.loupe);
    modal.appendChild(stage);
    bindCalibrationMouse();

    // Region chips, grouped so the (many) boxes stay readable.
    el.chips = h("div", "watch-chips");
    function chipGroup(title, keys, cls) {
      var g = h("div", "chip-group");
      g.appendChild(h("div", "chip-group-title", title));
      var row = h("div", "chip-row");
      keys.forEach(function (key) {
        var c = h("button", "watch-chip" + cls, REGION_LABELS[key]);
        c.dataset.key = key;
        c.addEventListener("click", function () { cancelPoly(); selectedKey = key; calibrating = true; refreshChips(); setStatus("Click each corner of " + REGION_LABELS[key] + "; click the first point again to finish."); drawOverlay(); });
        row.appendChild(c);
      });
      g.appendChild(row);
      el.chips.appendChild(g);
    }
    chipGroup("Your cards & board", REGION_KEYS, "");
    chipGroup("Numbers (optional)", NUM_KEYS, " num");
    chipGroup("Opponent seats (set the count below)", SEAT_KEYS, " wseat");
    modal.appendChild(el.chips);

    // Live results strip. Click any card slot to correct/teach it by hand.
    el.strip = h("div", "watch-strip");
    el.strip.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var seat = e.target.closest("[data-seat]");
      if (seat) { openSeatMenu(seat.getAttribute("data-seat")); return; }
      var chip = e.target.closest("[data-key]");
      if (chip) openCorrect(chip.getAttribute("data-key"));
    });
    modal.appendChild(el.strip);

    // Teach panel
    el.teach = h("div", "watch-teach"); el.teach.hidden = true;
    modal.appendChild(el.teach);

    // Manual-correction popup: click any card in the live strip to override
    // what it read and teach the right card at the same time.
    el.correct = h("div", "watch-teach watch-correct"); el.correct.hidden = true;
    modal.appendChild(el.correct);

    // Seat setup row: how many opponent seats, and teaching the three looks.
    var seatRow = h("div", "watch-seatrow");
    seatRow.appendChild(labelWrap("Opponent seats", seatCountInput()));
    seatRow.appendChild(mkbtn("All seats empty ↺", function () { teachAllSeats("empty"); }, "primary"));
    seatRow.appendChild(h("span", "watch-note seatnote",
      "Box each opponent seat above, then teach the looks: click a seat in the strip below and say " +
      "whether it's empty, folded or in the hand. Only in-hand players count toward the odds."));
    modal.appendChild(seatRow);

    // Settings row
    var settings = h("div", "watch-settings");
    settings.appendChild(labelWrap("Capture rate", rateSlider()));
    settings.appendChild(labelWrap("Match sensitivity", sensSlider()));
    var clear = h("div", "watch-clearbtns");
    clear.appendChild(mkbtn("Clear boxes", function () {
      regions = {}; saveJSON(LS_REGIONS, regions);
      refreshChips(); drawOverlay(); setStatus("Calibration cleared.");
    }));
    clear.appendChild(mkbtn("Forget taught cards", function () {
      templates = []; ignored = []; saveJSON(LS_TEMPLATES, templates); saveJSON(LS_IGNORE, ignored);
      setStatus("Taught glyphs + skips cleared.");
    }));
    clear.appendChild(mkbtn("Forget seat looks", function () {
      seatStates = { empty: [], folded: [], active: [] }; saveJSON(LS_SEATSTATES, seatStates);
      setStatus("Taught seat looks cleared.");
    }));
    settings.appendChild(clear);
    modal.appendChild(settings);

    modal.appendChild(h("p", "watch-note",
      "One-time setup per site: pick a box below, then click around each of your two cards, the " +
      "five board spots, and (optional) the Pot and My-stack numbers — one straight edge at a " +
      "time, clicking the first point again to close. Trace just inside the card so the green felt " +
      "and any neighbouring card are left out. The whole 52-card deck is recognised from the " +
      "built-in database — usually no teaching at all. Tip: zoom the poker window (Ctrl/Cmd +) so " +
      "cards are bigger — accuracy improves. Any misread card is one tap to fix on the table."));
    modal.appendChild(h("p", "watch-note",
      "Seats (opponents only — you're the last player): set Opponent seats to how many are at your " +
      "table, then box that many seat spots (the extra Seat chips are dimmed). Teach the three " +
      "looks by clicking a seat in the strip and saying whether it's empty, folded or in the hand — " +
      "or use \"All seats empty\" between hands to record them all at once. Empty is matched by the " +
      "plus-sign shape; folded vs in-hand is told apart by how vivid (opaque) the avatar is, so it " +
      "works across different player pictures. Each seat then shows ＋ empty, ◑ folded or ● in-hand, " +
      "and only in-hand opponents (+ you) count toward the odds. Mark your own seat with ⌂."));

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
    // The dock is a mirror; to correct a card, expand back to the full panel.
    el.dockStrip.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var seat = e.target.closest("[data-seat]");
      if (seat) { openModal(); openSeatMenu(seat.getAttribute("data-seat")); return; }
      var chip = e.target.closest("[data-key]");
      if (chip) { openModal(); openCorrect(chip.getAttribute("data-key")); }
    });
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
    // Controls how close a card glyph must be to a database/taught exemplar to be
    // accepted. Lower = stricter (fewer wrong reads, more "teach" prompts);
    // higher = looser (recognises more, small risk of a wrong guess you can fix).
    var s = document.createElement("input"); s.type = "range"; s.min = 35; s.max = 62; s.value = Math.round(rankThr * 100);
    s.addEventListener("input", function () { rankThr = +s.value / 100; suitThr = Math.round(rankThr * 80) / 100; });
    return s;
  }
  // Number of opponent seats to watch (1..6). Setting it also updates the table
  // player count straight away (opponents + you), so you can just type the size.
  function seatCountInput() {
    var s = document.createElement("input");
    s.type = "number"; s.min = 1; s.max = MAX_SEATS; s.step = 1; s.value = seatCount; s.className = "watch-seatcount";
    s.addEventListener("input", function () {
      var v = Math.max(1, Math.min(MAX_SEATS, parseInt(this.value || "1", 10)));
      seatCount = v; saveJSON(LS_SEATCOUNT, v);
      if (API.setPlayerCount) API.setPlayerCount(v + 1);   // opponents + you
      refreshChips();
      setStatus("Watching " + v + " opponent seat" + (v === 1 ? "" : "s") + " (" + (v + 1) + " players incl. you).");
    });
    return s;
  }
  // Record the current look of a seat spot as an example of a state. Empty keeps
  // a signature (the plus-sign shape); all keep vibrancy (opacity).
  function teachSeat(key, state) {
    if (!grabFrame()) { setStatus("Share a tab first."); return; }
    if (!regions[key] || !seatStates[state]) return;
    var img = regionImageData(regions[key]);
    var entry = { vib: regionVibrancy(img) };
    if (state === "empty") entry.vec = Array.prototype.slice.call(signature(img).vec);
    seatStates[state].push(entry);
    if (seatStates[state].length > 16) seatStates[state].shift();
    saveJSON(LS_SEATSTATES, seatStates);
    stab[key] = null;
    setStatus(REGION_LABELS[key] + " recorded as " + (state === "active" ? "in the hand" : state) + ".");
  }
  // Bulk-teach: record every boxed opponent seat as the same state (handy for
  // "all seats empty" between hands).
  function teachAllSeats(state) {
    if (!grabFrame()) { setStatus("Share a tab first."); return; }
    var n = 0;
    for (var i = 0; i < seatCount; i++) { var k = SEAT_KEYS[i]; if (regions[k]) { teachSeat(k, state); n++; } }
    setStatus(n ? ("Recorded " + n + " seat(s) as " + (state === "active" ? "in the hand" : state) + ".")
                : "Box your opponent seats first.");
  }
  // Small popup to label a seat's current look (opened from the live strip).
  function openSeatMenu(key) {
    if (SEAT_KEYS.indexOf(key) < 0 || !el.correct) return;
    el.correct.innerHTML = "";
    el.correct.appendChild(h("div", "teach-title", "What does " + REGION_LABELS[key] + " look like right now?"));
    var row = h("div", "teach-extra");
    [["active", "In the hand"], ["folded", "Folded"], ["empty", "Empty"]].forEach(function (s) {
      row.appendChild(mkbtn(s[1], function () { teachSeat(key, s[0]); closeCorrect(); }));
    });
    el.correct.appendChild(row);
    var row2 = h("div", "teach-extra");
    row2.appendChild(mkbtn("Cancel", closeCorrect));
    el.correct.appendChild(row2);
    el.correct.hidden = false;
  }

  function setStatus(t) { if (el.status) el.status.textContent = t; }
  function updateButtons() {
    if (!el.watch) return;
    el.watch.textContent = watching ? "Pause" : "Start watching";
    el.calib.classList.toggle("watch-primary", calibrating);
    el.stop.disabled = !stream;
    el.watch.disabled = !stream;
  }
  function toggleCalibrate() { calibrating = !calibrating; if (!calibrating) { selectedKey = null; cancelPoly(); } updateButtons(); drawOverlay(); setStatus(calibrating ? "Pick a box below, then click its corners to trace it." : "Calibration off."); }
  function toggleWatch() { if (watching) pauseWatching(); else startWatching(); }

  function refreshChips() {
    if (!el.chips) return;
    [].forEach.call(el.chips.querySelectorAll(".watch-chip"), function (c) {
      var key = c.dataset.key;
      c.classList.toggle("set", !!regions[key]);
      c.classList.toggle("active", selectedKey === key);
      // Seats beyond the chosen count are dimmed - they aren't watched.
      var si = SEAT_KEYS.indexOf(key);
      c.classList.toggle("beyond", si >= 0 && si >= seatCount);
    });
  }

  // Calibration drawing + mouse.
  function stageScale() {
    var r = video.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  }
  // Magnifier: draw a zoomed crop of the live frame around the cursor, with a
  // crosshair, so box edges can be placed on small cards precisely.
  function drawLoupe(p) {
    if (!el.loupe || !video) return;
    if (!grabFrame()) return;                 // refresh the source frame
    var vw = work.width, vh = work.height;
    if (!vw || !vh) return;
    var srcX = (p.x / p.W) * vw, srcY = (p.y / p.H) * vh;
    var srcHalf = 24;                         // half-window of source px shown
    var sx = Math.max(0, Math.min(vw - srcHalf * 2, srcX - srcHalf));
    var sy = Math.max(0, Math.min(vh - srcHalf * 2, srcY - srcHalf));
    var L = el.loupe.width, ctx = el.loupe.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, L, L);
    ctx.drawImage(work, sx, sy, srcHalf * 2, srcHalf * 2, 0, 0, L, L);
    // crosshair at the true cursor position within the window
    var cxp = ((srcX - sx) / (srcHalf * 2)) * L, cyp = ((srcY - sy) / (srcHalf * 2)) * L;
    ctx.strokeStyle = "rgba(245,185,59,.95)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cxp, 0); ctx.lineTo(cxp, L); ctx.moveTo(0, cyp); ctx.lineTo(L, cyp); ctx.stroke();
    // keep the loupe near the cursor but out from under it, flipping at edges
    var off = 18, lx = p.x + off, ly = p.y + off;
    if (lx + L > p.W) lx = p.x - off - L;
    if (ly + L > p.H) ly = p.y - off - L;
    el.loupe.style.left = Math.max(0, lx) + "px";
    el.loupe.style.top = Math.max(0, ly) + "px";
    el.loupe.hidden = false;
  }
  function drawOverlay() {
    if (!el.canvas || !video) return;
    var r = video.getBoundingClientRect();
    el.canvas.width = r.width; el.canvas.height = r.height;
    var ctx = el.canvas.getContext("2d");
    ctx.clearRect(0, 0, r.width, r.height);
    ALL_KEYS.forEach(function (key) {
      var rect = regions[key]; if (!rect) return;
      var col = key === selectedKey ? "#f5b93b"
        : SEAT_KEYS.indexOf(key) >= 0 ? "#a78bfa"
        : NUM_KEYS.indexOf(key) >= 0 ? "#f5b93b"
        : key.indexOf("hero") === 0 ? "#4ade80" : "#60a5fa";
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      var lx, ly;
      if (rect.poly && rect.poly.length >= 3) {           // traced outline
        ctx.beginPath();
        rect.poly.forEach(function (pt, i) { var X = pt.x * r.width, Y = pt.y * r.height; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.closePath(); ctx.stroke();
        lx = rect.x * r.width; ly = rect.y * r.height;
      } else {                                             // legacy rectangle
        ctx.strokeRect(rect.x * r.width, rect.y * r.height, rect.w * r.width, rect.h * r.height);
        lx = rect.x * r.width; ly = rect.y * r.height;
      }
      ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.font = "11px system-ui";
      var label = REGION_LABELS[key];
      ctx.fillRect(lx, ly - 14, ctx.measureText(label).width + 8, 14);
      ctx.fillStyle = "#fff"; ctx.fillText(label, lx + 4, ly - 3);
    });
    // In-progress traced outline: straight segments between clicked points, a
    // rubber-band to the cursor, and the closing edge snapping back to the start.
    if (polyPts && polyPts.length) {
      ctx.strokeStyle = "#f5b93b"; ctx.lineWidth = 2;
      ctx.beginPath();
      polyPts.forEach(function (pt, i) { if (i) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y); });
      var nearStart = polyHover && polyPts.length >= 3 && dist2(polyHover, polyPts[0]) <= closeR2();
      var end = nearStart ? polyPts[0] : polyHover;
      if (end) ctx.lineTo(end.x, end.y);
      ctx.stroke();
      // vertices
      polyPts.forEach(function (pt, i) {
        ctx.beginPath(); ctx.arc(pt.x, pt.y, i === 0 ? 5 : 3, 0, 6.2832);
        ctx.fillStyle = i === 0 ? (nearStart ? "#4ade80" : "#f5b93b") : "#f5b93b"; ctx.fill();
      });
      if (nearStart) { ctx.strokeStyle = "#4ade80"; ctx.beginPath(); ctx.arc(polyPts[0].x, polyPts[0].y, 8, 0, 6.2832); ctx.stroke(); }
    }
  }
  function dist2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
  // Calibration: trace a box one straight edge at a time. Click to drop each
  // corner; the closing edge snaps back to the first point when you click near
  // it (or press Enter / double-click). Backspace undoes a point, Esc cancels.
  function bindCalibrationMouse() {
    var c = el.canvas;
    function pos(e) { var r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height }; }
    c.addEventListener("mousemove", function (e) {
      if (!calibrating || !selectedKey) return;
      var p = pos(e); polyHover = { x: p.x, y: p.y };
      drawLoupe(p); drawOverlay();
    });
    c.addEventListener("mouseleave", function () { if (el.loupe) el.loupe.hidden = true; });
    c.addEventListener("click", function (e) {
      if (!calibrating || !selectedKey) { setStatus("Pick a box below first (Calibrate), then click its corners."); return; }
      var p = pos(e), pt = { x: p.x, y: p.y, W: p.W, H: p.H };
      if (polyPts && polyPts.length >= 3 && dist2(pt, polyPts[0]) <= closeR2()) { finishPoly(); return; }
      if (!polyPts) polyPts = [];
      polyPts.push(pt);
      setStatus(polyPts.length < 3
        ? "Point " + polyPts.length + " placed — keep clicking the corners of " + REGION_LABELS[selectedKey] + "."
        : "Click the next corner, or click the first point (green) to finish.");
      drawOverlay();
    });
    c.addEventListener("dblclick", function (e) { if (polyPts && polyPts.length >= 3) { e.preventDefault(); finishPoly(); } });
    document.addEventListener("keydown", function (e) {
      if (!calibrating || !polyPts) return;
      if (e.key === "Enter" && polyPts.length >= 3) { e.preventDefault(); finishPoly(); }
      else if (e.key === "Escape") { cancelPoly(); setStatus("Trace cancelled."); }
      else if (e.key === "Backspace") { e.preventDefault(); polyPts.pop(); if (!polyPts.length) polyPts = null; drawOverlay(); }
    });
  }
  function cancelPoly() { polyPts = null; polyHover = null; if (el.loupe) el.loupe.hidden = true; drawOverlay(); }
  function finishPoly() {
    if (!polyPts || polyPts.length < 3 || !selectedKey) { cancelPoly(); return; }
    var W = polyPts[0].W, H = polyPts[0].H;
    var poly = polyPts.map(function (p) { return { x: p.x / W, y: p.y / H }; });
    var xs = poly.map(function (p) { return p.x; }), ys = poly.map(function (p) { return p.y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var key = selectedKey;
    cancelPoly();
    if (x1 - x0 < 0.01 || y1 - y0 < 0.01) { setStatus("That box was too small — try again."); return; }
    regions[key] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, poly: poly };
    saveJSON(LS_REGIONS, regions);
    stab[key] = null;                      // re-read the new box from scratch
    delete teachSuppressed[key];           // a fresh box may now be readable
    // Show the best-fit read for this box straight away (card regions).
    var guess = bestFitFor(key);
    setStatus(REGION_LABELS[key] + " traced." + (guess ? "  Best fit: " + guess : ""));
    // Advance to the next unset region; if all are set, leave calibration so the
    // re-boxed region can be read/prompted again instead of staying suppressed.
    var next = ALL_KEYS.filter(function (k) { return !regions[k]; })[0];
    if (next) { selectedKey = next; }
    else { selectedKey = null; calibrating = false; updateButtons(); }
    refreshChips(); drawOverlay();
  }
  // Grab the current frame and report the best database fit for a just-traced
  // box, so calibration confirms what it will read.
  function bestFitFor(key) {
    if (REGION_KEYS.indexOf(key) < 0 || !stream) return null;
    if (!grabFrame()) return null;
    var res = recognizeCard(regionImageData(regions[key]));
    if (res.status === "card") return Poker.cardLabel(res.id);
    if (res.status === "empty") return "empty";
    return res.teach ? "needs the " + (res.teach === "rank" ? "number" : res.teach) : "unrecognised (teach it)";
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
      // Any boxed card slot can be tapped to correct/teach it by hand.
      if (regions[key]) { chip.setAttribute("data-key", key); chip.classList.add("clickable"); }
      chip.title = REGION_LABELS[key] + (regions[key] ? " — click to set/correct" : "");
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
    // Seat readout — only the seats within the count. Click a chip to teach its
    // current look (empty / folded / in the hand).
    var anySeat = SEAT_KEYS.slice(0, seatCount).some(function (k) { return regions[k]; });
    if (anySeat) {
      el.strip.appendChild(h("span", "strip-sep", "·"));
      var trained = seatStates.empty.length || seatStates.folded.length || seatStates.active.length;
      SEAT_KEYS.slice(0, seatCount).forEach(function (key, idx) {
        if (!regions[key]) return;
        var st = stab[key];
        var state = st && st.state ? st.state : "active";
        var glyph = state === "active" ? "●" : state === "folded" ? "◑" : "＋";
        var chip = h("span", "strip-seat clickable " + state, (idx + 1) + glyph);
        chip.setAttribute("data-seat", key);
        chip.title = "Seat " + (idx + 1) + " — " +
          (state === "active" ? "in the hand" : state === "folded" ? "folded" : "empty") +
          " · click to teach its look" + (trained ? "" : " (not taught yet)");
        if (!trained) chip.classList.add("nobase");
        el.strip.appendChild(chip);
      });
    }
    if (el.dockStrip) el.dockStrip.innerHTML = el.strip.innerHTML; // mirror into the dock
  }
  function cardColor(id) { return Poker.SUIT_COLOR[Poker.suitOf(id)]; }

  // Teach panel for unknown cards.
  var teaching = null, renderedTeachId = null;
  function renderTeach(unknowns) {
    if (!el.teach) return;
    if (!unknowns.length && !teaching) {
      if (renderedTeachId !== null) { el.teach.hidden = true; el.teach.innerHTML = ""; renderedTeachId = null; }
      return;
    }
    if (!teaching && unknowns.length) teaching = unknowns[0];
    if (!teaching) { return; }
    // Only rebuild the picker when the item actually changes - otherwise the
    // buttons get recreated under your finger every frame and clicks miss.
    var id = teaching.key + ":" + teaching.kind;
    if (id === renderedTeachId) return;
    renderedTeachId = id;
    teachKind = teaching.kind;   // the recogniser's guess; you can switch it
    drawTeach();
  }
  var teachKind = null;
  function drawTeach() {
    if (!teaching) return;
    el.teach.hidden = false;
    el.teach.innerHTML = "";
    var isCard = teaching.kind !== "digit";
    var partName = teaching.kind === "suit" ? "suit" : teaching.kind === "rank" ? "number" : "digit";
    el.teach.appendChild(h("div", "teach-title",
      (teaching.cut ? "The " + partName + " isn't inside the box for " : "Unrecognised " + partName + " in ") +
      REGION_LABELS[teaching.key] +
      (isCard ? (teaching.cut ? " — Re-box to include it:" : " — pick it, switch Rank/Suit, or Re-box:") : " — pick the digit, or Re-box:")));
    el.teach.appendChild(h("div", "teach-hint",
      teaching.cut
        ? "The number was read fine, but nothing was found below it, so the " +
          "box is cut off before the " + partName + ". Use ↻ Re-box to draw a box " +
          "that includes the whole rank AND the suit under it."
        : "This is exactly what the box captured (magnified) — and it's the " + partName +
          ", nothing else. If it's cut off, blank or the wrong thing, use ↻ Re-box " +
          "to redraw it; zoom the poker window first for a bigger, clearer target."));
    var body = h("div", "teach-body");
    var thumb = h("canvas", "teach-thumb");
    thumb.width = teaching.img.width; thumb.height = teaching.img.height;
    thumb.getContext("2d").putImageData(teaching.img, 0, 0);
    body.appendChild(thumb);

    var right = h("div", "teach-right");
    if (isCard) {
      var seg = h("div", "teach-typeseg");
      [["rank", "Rank"], ["suit", "Suit"]].forEach(function (t) {
        var tb = h("button", "teach-type" + (teachKind === t[0] ? " active" : ""), t[1]);
        tb.addEventListener("click", function () { teachKind = t[0]; drawTeach(); });
        seg.appendChild(tb);
      });
      right.appendChild(seg);
    }
    var grid = h("div", "teach-grid " + teachKind);
    if (teachKind === "digit") {
      ["0","1","2","3","4","5","6","7","8","9","K","M"].forEach(function (g) {
        var btn = h("button", "teach-pick", g);
        btn.addEventListener("click", function () { teachAs(g, "digit"); });
        grid.appendChild(btn);
      });
    } else if (teachKind === "suit") {
      [["s","♠","black"],["h","♥","red"],["d","♦","red"],["c","♣","black"]].forEach(function (s) {
        var btn = h("button", "teach-pick " + s[2], s[1]);
        btn.addEventListener("click", function () { teachAs(s[0], "suit"); });
        grid.appendChild(btn);
      });
    } else {
      ["A","K","Q","J","10","9","8","7","6","5","4","3","2"].forEach(function (rk) {
        var btn = h("button", "teach-pick", rk);
        btn.addEventListener("click", function () { teachAs(rk, "rank"); });
        grid.appendChild(btn);
      });
    }
    right.appendChild(grid);
    body.appendChild(right);
    el.teach.appendChild(body);

    var extra = h("div", "teach-extra");
    extra.appendChild(mkbtn("↻ Re-box this region", function () {
      var key = teaching.key;
      teaching = null; renderedTeachId = null; el.teach.hidden = true; el.teach.innerHTML = "";
      stab[key] = null;
      teachSuppressed[key] = "rebox";        // don't re-prompt mid-trace
      cancelPoly(); selectedKey = key; calibrating = true; refreshChips();
      setStatus("Re-tracing " + REGION_LABELS[key] + " — click its corners (zoom the poker window for a bigger target).");
      drawOverlay();
    }));
    extra.appendChild(mkbtn("Skip (ignore this)", function () {
      var key = teaching.key;
      ignored.push({ kind: teaching.kind, red: teaching.sig.red, vec: Array.prototype.slice.call(teaching.sig.vec) });
      saveJSON(LS_IGNORE, ignored);
      // Stop re-prompting for this region until what it shows changes.
      teachSuppressed[key] = stab[key] ? stab[key].val : "skip";
      teaching = null; renderedTeachId = null; el.teach.hidden = true; el.teach.innerHTML = "";
      setStatus(REGION_LABELS[key] + " skipped — it won't ask again until that card changes.");
    }));
    el.teach.appendChild(extra);
  }

  // Pull both glyphs (rank + suit) out of a card region image, for corrections
  // and for building the DB. Normalised to the marks first so it matches how
  // recognizeCard reads live crops.
  function extractGlyphs(img) {
    var card = normalizeCard(img);
    var c = segmentCard(subImage(card, CORNER.x0, CORNER.y0, CORNER.x1, CORNER.y1));
    if (c && c.suitSig && !c.cut) return c;
    var w = segmentCard(card);
    if (w && w.suitSig && !w.cut) return w;
    return (c && c.rankSig) ? c : w;
  }
  // Correct a card region to a specific card AND teach its glyphs.
  function correctCard(key, rankLabel, suitLabel) {
    var st = stab[key], learned = false;
    if (st && st.cardImg) {
      var g = extractGlyphs(st.cardImg);
      if (g && g.rankSig) { templates.push({ label: rankLabel, kind: "rank", red: 0, vec: Array.prototype.slice.call(g.rankSig.vec) }); learned = true; }
      if (g && g.suitSig) { templates.push({ label: suitLabel, kind: "suit", red: g.suitSig.red, vec: Array.prototype.slice.call(g.suitSig.vec) }); }
      if (learned) saveJSON(LS_TEMPLATES, templates);
      st.val = null;
    }
    setCardValue(key, Poker.makeId(RANK_VAL[rankLabel], SUIT_CODE[suitLabel]));
    setStatus("Set " + REGION_LABELS[key] + " = " + rankLabel + suitLabel + (learned ? " and learned it." : "."));
  }
  function setCardValue(key, idOrNull) {
    var reading = {};
    if (key === "hero0") reading.hero = [idOrNull, undefined];
    else if (key === "hero1") reading.hero = [undefined, idOrNull];
    else { reading.board = [undefined, undefined, undefined, undefined, undefined]; reading.board[+key.slice(1)] = idOrNull; }
    API.applyReading(reading);
  }
  // Correction popup: set the true card for a region (also teaches it).
  function openCorrect(key) {
    if (REGION_KEYS.indexOf(key) < 0) return;
    el.correct.innerHTML = "";
    el.correct.appendChild(h("div", "teach-title", "Set " + REGION_LABELS[key] + " to the right card (this teaches it too):"));
    var grid = h("div", "correct-grid");
    [["s","♠","black"],["h","♥","red"],["d","♦","red"],["c","♣","black"]].forEach(function (s) {
      ["A","K","Q","J","10","9","8","7","6","5","4","3","2"].forEach(function (rk) {
        var btn = h("button", "teach-pick " + s[2], rk + s[1]);
        btn.addEventListener("click", function () { correctCard(key, rk, s[0]); closeCorrect(); });
        grid.appendChild(btn);
      });
    });
    el.correct.appendChild(grid);
    var row = h("div", "teach-extra");
    row.appendChild(mkbtn("Clear this card", function () { setCardValue(key, null); closeCorrect(); }));
    row.appendChild(mkbtn("Cancel", closeCorrect));
    el.correct.appendChild(row);
    el.correct.hidden = false;
  }
  function closeCorrect() { if (el.correct) el.correct.hidden = true; }
  function teachAs(label, kind) {
    if (!teaching) return;
    templates.push({ label: label, kind: kind, red: teaching.sig.red, vec: Array.prototype.slice.call(teaching.sig.vec) });
    saveJSON(LS_TEMPLATES, templates);
    stab[teaching.key] = null; // force re-evaluate
    teaching = null; renderedTeachId = null;
    el.teach.hidden = true; el.teach.innerHTML = "";
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
    _extractGlyphs: extractGlyphs, _segmentCard: segmentCard, _nearest: nearestKind,
    _pointInPoly: pointInPoly, _maskOutsidePoly: maskOutsidePoly, _normalizeCard: normalizeCard,
    _vibrancy: regionVibrancy, _seatKeys: function () { return SEAT_KEYS.slice(); },
    _classifySeat: classifySeat, _seatStates: function () { return seatStates; },
    _regions: function () { return regions; }, _templates: function () { return templates; },
    _dbCount: function () { return dbTemplates.length; },
    _setWatching: function (v) { watching = v; }, _open: openModal, _close: closeModal,
    _useStream: function (s) { if (!el.overlay) buildModal(); stream = s; video.srcObject = s; video.play(); },
    _start: startWatching, _videoParent: function () { return video && video.parentNode ? video.parentNode.className : null; },
  };
})();
