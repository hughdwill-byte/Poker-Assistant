/*
 * hud.js - the Poker Assistant "HUD Overlay" content script.
 *
 * Mounts a war-style tactical HUD inside a Shadow DOM root layered over the
 * current tab. Three panels: a movable/resizable Table box, a movable/resizable
 * scrollable Info panel, and a border-docked Taskbar holding all controls.
 * Layout maths (clamp / snap / breakpoints / persistence) come from the pure,
 * separately-tested Poker.HudLayout module.
 *
 * Runs in two environments from ONE codebase:
 *   - as an extension content script (chrome.* present): persists to
 *     chrome.storage.local, loads the equity worker from chrome.runtime.getURL.
 *   - loaded on the Poker Assistant page itself via the in-app toggle
 *     (chrome.* absent): persists to localStorage, loads "js/worker.js".
 *
 * ADVISORY ONLY. This script reads NOTHING from the underlying site's DOM and
 * performs NO poker action. Every number shown is computed by the existing
 * engine from inputs the user types into the HUD.
 */
(function () {
  "use strict";
  if (window.PokerHUD) return; // idempotent: re-injection is a no-op

  var HL = (self.Poker && self.Poker.HudLayout) || null;
  var hasChrome = typeof chrome !== "undefined" && chrome.runtime && !!chrome.runtime.getURL;
  var STORE_KEY = "pokerHudLayout";
  var HUD_ID = "poker-assistant-hud-root";

  // ---- environment helpers -------------------------------------------------
  function resURL(path) { return hasChrome ? chrome.runtime.getURL(path) : path; }

  function storeGet(cb) {
    try {
      if (hasChrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([STORE_KEY], function (o) { cb(o && o[STORE_KEY]); });
        return;
      }
    } catch (e) { /* fall through to localStorage */ }
    try { cb(window.localStorage.getItem(STORE_KEY)); }
    catch (e2) { cb(null); }
  }
  function storeSet(str) {
    try {
      if (hasChrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(genObj(STORE_KEY, str));
        return;
      }
    } catch (e) { /* fall through */ }
    try { window.localStorage.setItem(STORE_KEY, str); } catch (e2) { /* ignore */ }
  }
  function genObj(k, v) { var o = {}; o[k] = v; return o; }

  // ---- card-text parsing (input only; mirrors engine id = (rank<<2)|suit) --
  var RANK_MAP = { "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "t": 10, "j": 11, "q": 12, "k": 13, "a": 14 };
  var SUIT_MAP = { c: 0, d: 1, h: 2, s: 3 };
  var SUIT_SYM = { 0: "♣", 1: "♦", 2: "♥", 3: "♠" };
  var RANK_LBL = { 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };

  function parseCards(text) {
    // Accepts "As Kd", "AsKd", "th9h2c" etc. Returns { ids, bad }.
    var out = [], bad = false, seen = {};
    var t = String(text || "").toLowerCase().replace(/10/g, "t").replace(/[^0-9tjqkacdhs]/g, "");
    for (var i = 0; i < t.length - 1; ) {
      var r = RANK_MAP[t[i]], s = SUIT_MAP[t[i + 1]];
      if (r == null || s == null) { bad = true; i++; continue; }
      var id = (r << 2) | s;
      if (seen[id]) { bad = true; } else { seen[id] = 1; out.push(id); }
      i += 2;
    }
    return { ids: out, bad: bad };
  }
  function cardLabel(id) { return RANK_LBL[id >> 2] + SUIT_SYM[id & 3]; }
  function isRed(id) { var s = id & 3; return s === 1 || s === 2; }

  // ================= HUD singleton ==========================================
  var HUD = {
    mounted: false,
    host: null,
    root: null,
    boxes: {},        // { table:{el,body,handleEls,observer}, info:{...} }
    taskbar: null,
    layout: null,
    z: 10,
    worker: null,
    jobId: 0,
    lastResult: null,
    cleanup: [],      // teardown thunks (listeners, observers, worker)
    inputs: {},
  };

  // Register a listener and remember how to remove it (clean revert).
  function on(el, type, fn, opts) {
    el.addEventListener(type, fn, opts);
    HUD.cleanup.push(function () { el.removeEventListener(type, fn, opts); });
  }

  function viewport() {
    return { w: window.innerWidth || document.documentElement.clientWidth,
             h: window.innerHeight || document.documentElement.clientHeight };
  }

  // ---- element factory -----------------------------------------------------
  function h(tag, cls, attrs) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) for (var k in attrs) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "html") el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  // ================= mount ==================================================
  function mount() {
    if (HUD.mounted) return;
    if (!HL) { console.warn("[Poker HUD] layout module missing"); return; }

    HUD.host = h("div", null, { id: HUD_ID });
    // The host must not inherit or leak layout; it is a fixed full-viewport
    // passthrough layer. Inline styles here can't be overridden by site CSS
    // because the visible HUD lives in the shadow root below.
    HUD.host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    HUD.root = HUD.host.attachShadow({ mode: "open" });

    // Styles: link the shadow-scoped stylesheet; site CSS cannot cross in.
    var link = h("link", null, { rel: "stylesheet", href: resURL("extension/hud.css") });
    HUD.root.appendChild(link);

    var wrap = h("div", "hud-root");
    if (matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wrap.setAttribute("data-reduced-motion", "1");
    }
    HUD.root.appendChild(wrap);

    buildTableBox(wrap);
    buildInfoBox(wrap);
    buildTaskbar(wrap);

    document.body.appendChild(HUD.host);
    HUD.mounted = true;

    // Load persisted layout (or defaults), then apply.
    storeGet(function (saved) {
      var vp = viewport();
      var base = HL.defaultLayout(vp);
      var loaded = saved ? HL.deserialize(saved, base) : base;
      HUD.layout = HL.clampLayout(loaded, vp);
      applyLayout();
      startWorker();
      compute();
    });

    // Keep everything on-screen as the window resizes.
    var onResize = function () {
      if (!HUD.mounted) return;
      HUD.layout = HL.clampLayout(HUD.layout, viewport());
      applyLayout();
      reflow("table"); reflow("info");
    };
    on(window, "resize", onResize);

    // ESC closes the HUD from anywhere within it.
    on(HUD.root, "keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); unmount(); }
    });
  }

  // ---- Table box -----------------------------------------------------------
  function buildTableBox(parent) {
    var box = h("div", "hud-box hud-table", { role: "dialog", "aria-label": "Table view", tabindex: "0" });
    var title = h("header", "hud-box-title");
    title.appendChild(h("span", "hud-title-brackets", { "aria-hidden": "true", text: "⌔" }));
    title.appendChild(h("span", "hud-title-text", { text: "TABLE" }));
    var move = h("span", "hud-drag-hint", { "aria-hidden": "true", text: "✥" });
    title.appendChild(move);
    box.appendChild(title);

    var body = h("div", "hud-box-body hud-table-body");
    // Compact input strip (advisory inputs — NOT scraped from any site).
    var form = h("div", "hud-inputs");
    form.appendChild(field("Hero", "hero", "text", "As Kd"));
    form.appendChild(field("Board", "board", "text", ""));
    form.appendChild(field("Players", "players", "number", "6", { min: "2", max: "10" }));
    form.appendChild(field("Pot", "pot", "number", "0", { min: "0" }));
    form.appendChild(field("To call", "call", "number", "0", { min: "0" }));
    form.appendChild(field("Stack", "stack", "number", "1000", { min: "0" }));
    body.appendChild(form);

    // Visual felt: hero cards, board, pot, seat ring.
    var felt = h("div", "hud-felt");
    felt.appendChild(h("div", "hud-felt-seats", { id: "hud-seats" }));
    var center = h("div", "hud-felt-center");
    center.appendChild(h("div", "hud-cards hud-board", { id: "hud-board-cards" }));
    center.appendChild(h("div", "hud-pot", { id: "hud-pot" , text: "POT 0" }));
    felt.appendChild(center);
    var heroRow = h("div", "hud-hero-row");
    heroRow.appendChild(h("span", "hud-hero-label", { text: "YOU" }));
    heroRow.appendChild(h("div", "hud-cards hud-hero-cards", { id: "hud-hero-cards" }));
    felt.appendChild(heroRow);
    body.appendChild(felt);

    box.appendChild(body);
    addResizeHandles(box);
    parent.appendChild(box);
    HUD.boxes.table = { el: box, body: body };
    wireBox("table");
    wireInputs();
  }

  function field(label, key, type, val, extra) {
    var wrap = h("label", "hud-field");
    wrap.appendChild(h("span", "hud-field-label", { text: label }));
    var inp = h("input", "hud-field-input", { type: type, value: val, spellcheck: "false" });
    if (extra) for (var k in extra) inp.setAttribute(k, extra[k]);
    inp.setAttribute("aria-label", label);
    wrap.appendChild(inp);
    HUD.inputs[key] = inp;
    return wrap;
  }

  // ---- Info box ------------------------------------------------------------
  function buildInfoBox(parent) {
    var box = h("div", "hud-box hud-info", { role: "dialog", "aria-label": "Intel and advice", tabindex: "0" });
    var title = h("header", "hud-box-title");
    title.appendChild(h("span", "hud-title-brackets", { "aria-hidden": "true", text: "⌖" }));
    title.appendChild(h("span", "hud-title-text", { text: "INTEL" }));
    title.appendChild(h("span", "hud-status-light", { id: "hud-status-light", "aria-hidden": "true" }));
    box.appendChild(title);

    var body = h("div", "hud-box-body hud-scroll", { id: "hud-intel", role: "region", "aria-live": "polite", "aria-label": "Computed advice" });
    body.appendChild(h("div", "hud-intel-empty", { text: "Enter your hand above to compute advice." }));
    box.appendChild(body);
    addResizeHandles(box);
    parent.appendChild(box);
    HUD.boxes.info = { el: box, body: body };
    wireBox("info");
  }

  // ---- Taskbar (docked, not draggable) -------------------------------------
  function buildTaskbar(parent) {
    var bar = h("div", "hud-taskbar", { role: "toolbar", "aria-label": "HUD controls", "data-edge": "bottom" });
    bar.appendChild(h("span", "hud-taskbar-brand", { text: "◈ POKER HUD" }));
    var group = h("div", "hud-taskbar-btns");

    HUD.modeBtn = tbtn(group, "SIMPLE", "Toggle simple / advanced readout", function () {
      var adv = HUD.host.classList.toggle("hud-advanced");
      HUD.modeBtn.textContent = adv ? "ADVANCED" : "SIMPLE";
      renderIntel(HUD.lastResult);
    });
    HUD.streetBtn = tbtn(group, "STREET", "Cycle street label (pre/flop/turn/river) — derived from board length", function () {
      compute();
    });
    tbtn(group, "NEXT", "Clear the board for the next hand", function () {
      HUD.inputs.board.value = ""; compute();
    });
    tbtn(group, "FLIP", "Flip the taskbar to the other edge", function () {
      HUD.layout.taskbar.edge = HUD.layout.taskbar.edge === "bottom" ? "top" : "bottom";
      applyTaskbarEdge(); persist();
    });
    tbtn(group, "RESET", "Reset the panel layout to defaults", function () {
      HUD.layout = HL.defaultLayout(viewport());
      applyLayout(); persist(); reflow("table"); reflow("info");
    });
    var close = tbtn(group, "✕ CLOSE", "Close the HUD and restore the page (Esc)", function () { unmount(); });
    close.classList.add("hud-btn-close");

    bar.appendChild(group);
    parent.appendChild(bar);
    HUD.taskbar = bar;
  }

  function tbtn(parent, label, title, fn) {
    var b = h("button", "hud-btn", { type: "button", title: title, "aria-label": title });
    b.textContent = label;
    on(b, "click", fn);
    parent.appendChild(b);
    return b;
  }

  // ================= layout application =====================================
  function applyLayout() {
    place("table", HUD.layout.table);
    place("info", HUD.layout.info);
    applyTaskbarEdge();
  }
  function place(key, rect) {
    var el = HUD.boxes[key].el;
    el.style.left = rect.x + "px";
    el.style.top = rect.y + "px";
    el.style.width = rect.w + "px";
    el.style.height = rect.h + "px";
  }
  function applyTaskbarEdge() {
    var edge = HUD.layout.taskbar.edge;
    HUD.taskbar.setAttribute("data-edge", edge);
  }

  function persist() { storeSet(HL.serialize(HUD.layout)); }

  function bringToFront(key) {
    HUD.z += 1;
    HUD.boxes[key].el.style.zIndex = String(HUD.z);
  }

  // ---- adaptive reflow -----------------------------------------------------
  function reflow(key) {
    var b = HUD.boxes[key];
    var w = b.el.getBoundingClientRect().width;
    var bp = HL.pickBreakpoint(w);
    b.el.setAttribute("data-bp", bp);
  }

  // ================= drag + resize (pointer) ================================
  function wireBox(key) {
    var b = HUD.boxes[key];
    var title = b.el.querySelector(".hud-box-title");

    on(b.el, "pointerdown", function () { bringToFront(key); }, true);
    on(b.el, "focusin", function () { bringToFront(key); });

    // Drag from the title bar.
    var drag = null;
    on(title, "pointerdown", function (e) {
      if (e.button != null && e.button !== 0) return;
      var r = HUD.layout[key];
      drag = { px: e.clientX, py: e.clientY, x: r.x, y: r.y };
      title.setPointerCapture(e.pointerId);
      b.el.classList.add("hud-dragging");
      e.preventDefault();
    });
    on(title, "pointermove", function (e) {
      if (!drag) return;
      var nx = drag.x + (e.clientX - drag.px);
      var ny = drag.y + (e.clientY - drag.py);
      var r = HUD.layout[key];
      HUD.layout[key] = HL.clampRect({ x: nx, y: ny, w: r.w, h: r.h }, viewport());
      place(key, HUD.layout[key]);
    });
    on(title, "pointerup", function (e) {
      if (!drag) return;
      drag = null;
      b.el.classList.remove("hud-dragging");
      try { title.releasePointerCapture(e.pointerId); } catch (x) {}
      HUD.layout[key] = HL.snapToEdges(HUD.layout[key], viewport());
      place(key, HUD.layout[key]);
      persist();
    });

    // Resize from the 8 handles.
    var handles = b.el.querySelectorAll(".hud-handle");
    Array.prototype.forEach.call(handles, function (hEl) {
      var dir = hEl.getAttribute("data-dir");
      var rz = null;
      on(hEl, "pointerdown", function (e) {
        var r = HUD.layout[key];
        rz = { px: e.clientX, py: e.clientY, x: r.x, y: r.y, w: r.w, h: r.h };
        hEl.setPointerCapture(e.pointerId);
        b.el.classList.add("hud-resizing");
        e.preventDefault(); e.stopPropagation();
      });
      on(hEl, "pointermove", function (e) {
        if (!rz) return;
        HUD.layout[key] = resizeRect(rz, dir, e.clientX - rz.px, e.clientY - rz.py);
        place(key, HUD.layout[key]);
        reflow(key);
      });
      on(hEl, "pointerup", function (e) {
        if (!rz) return;
        rz = null;
        b.el.classList.remove("hud-resizing");
        try { hEl.releasePointerCapture(e.pointerId); } catch (x) {}
        HUD.layout[key] = HL.snapToEdges(HUD.layout[key], viewport());
        place(key, HUD.layout[key]);
        reflow(key); persist();
      });
    });

    // Keyboard move/resize when the box (not an input) is focused.
    on(b.el, "keydown", function (e) {
      if (e.target && /^(INPUT|BUTTON|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      var step = e.shiftKey ? null : 12;
      var r = HUD.layout[key], nr = null;
      if (step != null) {
        if (e.key === "ArrowLeft") nr = { x: r.x - step, y: r.y, w: r.w, h: r.h };
        else if (e.key === "ArrowRight") nr = { x: r.x + step, y: r.y, w: r.w, h: r.h };
        else if (e.key === "ArrowUp") nr = { x: r.x, y: r.y - step, w: r.w, h: r.h };
        else if (e.key === "ArrowDown") nr = { x: r.x, y: r.y + step, w: r.w, h: r.h };
      } else {
        var d = 16;
        if (e.key === "ArrowLeft") nr = { x: r.x, y: r.y, w: r.w - d, h: r.h };
        else if (e.key === "ArrowRight") nr = { x: r.x, y: r.y, w: r.w + d, h: r.h };
        else if (e.key === "ArrowUp") nr = { x: r.x, y: r.y, w: r.w, h: r.h - d };
        else if (e.key === "ArrowDown") nr = { x: r.x, y: r.y, w: r.w, h: r.h + d };
      }
      if (!nr) return;
      e.preventDefault();
      HUD.layout[key] = HL.clampRect(nr, viewport());
      place(key, HUD.layout[key]); reflow(key); persist();
    });

    // Observe size to drive adaptive breakpoints.
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(function () { reflow(key); });
      ro.observe(b.el);
      HUD.cleanup.push(function () { ro.disconnect(); });
    }
  }

  function resizeRect(start, dir, dx, dy) {
    var x = start.x, y = start.y, w = start.w, hgt = start.h;
    if (dir.indexOf("e") >= 0) w = start.w + dx;
    if (dir.indexOf("s") >= 0) hgt = start.h + dy;
    if (dir.indexOf("w") >= 0) { x = start.x + dx; w = start.w - dx; }
    if (dir.indexOf("n") >= 0) { y = start.y + dy; hgt = start.h - dy; }
    // Enforce minimums by anchoring the opposite edge when shrinking past min.
    if (w < HL.MIN_W) { if (dir.indexOf("w") >= 0) x = start.x + start.w - HL.MIN_W; w = HL.MIN_W; }
    if (hgt < HL.MIN_H) { if (dir.indexOf("n") >= 0) y = start.y + start.h - HL.MIN_H; hgt = HL.MIN_H; }
    return HL.clampRect({ x: x, y: y, w: w, h: hgt }, viewport());
  }

  function addResizeHandles(box) {
    ["n", "s", "e", "w", "ne", "nw", "se", "sw"].forEach(function (d) {
      box.appendChild(h("span", "hud-handle hud-handle-" + d, { "data-dir": d, "aria-hidden": "true" }));
    });
  }

  // ================= compute (reuse the equity worker) ======================
  function startWorker() {
    try {
      HUD.worker = new Worker(resURL("js/worker.js"));
      HUD.worker.onmessage = function (e) {
        var msg = e.data || {};
        if (msg.id !== HUD.jobId) return; // ignore stale jobs
        HUD.lastResult = msg.result;
        renderIntel(msg.result);
      };
      HUD.worker.onerror = function () {
        // Worker blocked (typically the page's CSP). Fall back to computing
        // in-page if the engine is present; otherwise say so.
        HUD.worker = null;
        if (hasInPageEngine()) compute();
        else renderIntelError("Equity engine could not start on this page. Layout and controls still work.");
      };
      HUD.cleanup.push(function () { if (HUD.worker) { HUD.worker.terminate(); HUD.worker = null; } });
    } catch (err) {
      // new Worker() can throw synchronously under a strict page CSP — the
      // in-page fallback (used by compute) handles it, so don't alarm the user.
      HUD.worker = null;
    }
  }

  function readInputs() {
    var hero = parseCards(HUD.inputs.hero.value);
    var board = parseCards(HUD.inputs.board.value);
    var players = Math.max(2, Math.min(10, parseInt(HUD.inputs.players.value, 10) || 2));
    var pot = Math.max(0, parseFloat(HUD.inputs.pot.value) || 0);
    var call = Math.max(0, parseFloat(HUD.inputs.call.value) || 0);
    var stack = Math.max(0, parseFloat(HUD.inputs.stack.value) || 0);
    return { hero: hero, board: board, players: players, pot: pot, call: call, stack: stack };
  }

  var computeTimer = null;
  function wireInputs() {
    Object.keys(HUD.inputs).forEach(function (k) {
      on(HUD.inputs[k], "input", function () {
        if (computeTimer) clearTimeout(computeTimer);
        computeTimer = setTimeout(compute, 180);
      });
    });
  }

  function streetName(nBoard) {
    if (nBoard === 0) return "PRE-FLOP";
    if (nBoard === 3) return "FLOP";
    if (nBoard === 4) return "TURN";
    if (nBoard === 5) return "RIVER";
    return nBoard + " CARDS";
  }

  function compute() {
    var st = readInputs();
    renderFelt(st);
    if (HUD.streetBtn) HUD.streetBtn.textContent = streetName(st.board.ids.length);

    var warn = [];
    if (st.hero.bad || st.board.bad) warn.push("Some card text was ignored (bad/duplicate).");
    if (st.hero.ids.length !== 2) {
      renderIntel({ ok: false, _needHero: true, warnings: warn, state: st });
      return;
    }
    if (st.board.ids.length === 1 || st.board.ids.length === 2 || st.board.ids.length > 5) {
      warn.push("Board should be 0, 3, 4 or 5 cards; extra cards ignored in the felt.");
    }

    var players = [{ cards: st.hero.ids, active: true }];
    for (var i = 1; i < st.players; i++) players.push({ active: true });
    var board = st.board.ids.slice(0, 5);
    var cfg = { players: players, board: board, decks: 1, dead: [], trials: 40000 };
    HUD.jobId += 1;
    setStatusLight("busy");
    // stash the input state for renderIntel to combine with the result
    HUD._pending = { state: st, warnings: warn };
    dispatchSim(cfg);
  }

  // True when the equity engine is loaded into THIS world (the extension injects
  // it so equity works even where a Web Worker is blocked by the page's CSP).
  function hasInPageEngine() { return !!(self.Poker && typeof self.Poker.simulate === "function"); }

  // Compute equity via the Web Worker when available; otherwise fall back to an
  // in-page computation in the extension's isolated world, which the page's CSP
  // cannot block. Both paths honour the latest-job id (stale-job cancellation).
  function dispatchSim(cfg) {
    var jid = HUD.jobId;
    if (HUD.worker) {
      try { HUD.worker.postMessage({ id: jid, type: "simulate", cfg: cfg }); return; }
      catch (e) { HUD.worker = null; }
    }
    if (hasInPageEngine()) {
      // Defer so the "busy" light paints first; simulate is fast (~tens of ms).
      setTimeout(function () {
        if (jid !== HUD.jobId) return; // a newer job superseded this one
        var t0 = Date.now(), res;
        try { res = self.Poker.simulate(cfg); }
        catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
        if (res && typeof res === "object") res.ms = Date.now() - t0;
        HUD.lastResult = res;
        renderIntel(res);
      }, 0);
      return;
    }
    renderIntelError("Equity engine unavailable on this page.");
  }

  // ================= rendering =============================================
  function renderFelt(st) {
    var boardEl = HUD.root.getElementById("hud-board-cards");
    var heroEl = HUD.root.getElementById("hud-hero-cards");
    var potEl = HUD.root.getElementById("hud-pot");
    var seatsEl = HUD.root.getElementById("hud-seats");
    if (boardEl) boardEl.innerHTML = "";
    if (heroEl) heroEl.innerHTML = "";
    st.board.ids.slice(0, 5).forEach(function (id) { boardEl.appendChild(cardEl(id)); });
    st.hero.ids.slice(0, 2).forEach(function (id) { heroEl.appendChild(cardEl(id)); });
    if (potEl) potEl.textContent = "POT " + st.pot;
    if (seatsEl) {
      seatsEl.innerHTML = "";
      for (var i = 0; i < st.players; i++) {
        var s = h("span", "hud-seat" + (i === 0 ? " hud-seat-you" : ""), { text: i === 0 ? "Y" : String(i) });
        seatsEl.appendChild(s);
      }
    }
  }
  function cardEl(id) {
    var c = h("span", "hud-card" + (isRed(id) ? " hud-card-red" : ""));
    c.textContent = cardLabel(id);
    return c;
  }

  function setStatusLight(state) {
    var el = HUD.root.getElementById("hud-status-light");
    if (el) el.setAttribute("data-state", state);
  }

  function renderIntelError(text) {
    var el = HUD.root.getElementById("hud-intel");
    if (!el) return;
    el.innerHTML = "";
    el.appendChild(h("div", "hud-warn", { text: text }));
    setStatusLight("warn");
  }

  function renderIntel(result) {
    var el = HUD.root.getElementById("hud-intel");
    if (!el) return;
    var pend = HUD._pending || { state: readInputs(), warnings: [] };
    var st = (result && result.state) || pend.state;
    var warnings = (result && result.warnings) || pend.warnings || [];

    el.innerHTML = "";
    if (result && result._needHero) {
      el.appendChild(h("div", "hud-intel-empty", { text: "Enter both of your hole cards (e.g. As Kd) to compute equity." }));
      warnings.forEach(function (w) { el.appendChild(h("div", "hud-warn", { text: w })); });
      setStatusLight("idle");
      return;
    }
    if (!result || result.ok === false) {
      el.appendChild(h("div", "hud-warn", { text: (result && result.error) || "Could not compute." }));
      warnings.forEach(function (w) { el.appendChild(h("div", "hud-warn", { text: w })); });
      setStatusLight("warn");
      return;
    }

    var eq = result.results && result.results[0] ? result.results[0].equity : null;
    var pot = st.pot, call = st.call, stack = st.stack;
    var breakeven = call > 0 ? call / (pot + call) : 0;             // pot odds
    var callEV = eq != null ? eq * (pot + call) - call : null;       // one-street chip EV of calling
    var foldEV = 0;
    var spr = pot > 0 ? stack / pot : null;
    var effStack = stack;                                            // villain stacks unknown -> hero stack
    var confidence = result.mode === "exact" ? "EXACT" : ("~" + (result.trials || 0).toLocaleString() + " sims");

    // Primary verdict (advisory, exploitative one-street): call if equity beats
    // the pot-odds break-even; otherwise fold. A value-bet size is suggested
    // only as a reference fraction of pot.
    var verdict, verdictClass;
    if (call > 0) {
      if (eq >= breakeven) { verdict = "CALL"; verdictClass = "go"; }
      else { verdict = "FOLD"; verdictClass = "no"; }
    } else {
      verdict = eq >= 0.55 ? "BET / VALUE" : (eq >= 0.45 ? "CHECK" : "CHECK / GIVE-UP");
      verdictClass = eq >= 0.55 ? "go" : "hold";
    }

    var head = h("div", "hud-verdict hud-verdict-" + verdictClass);
    head.appendChild(h("span", "hud-verdict-word", { text: verdict }));
    head.appendChild(h("span", "hud-verdict-eq", { text: eq != null ? (eq * 100).toFixed(1) + "% eq" : "" }));
    el.appendChild(head);

    var advanced = HUD.host.classList.contains("hud-advanced");
    var rows = [
      ["Equity vs random", eq != null ? (eq * 100).toFixed(1) + "%" : "—"],
      ["Equity vs modelled range", "vs random (uniform) — use the app's Advanced mode for ranges"],
      ["Break-even (pot odds)", call > 0 ? (breakeven * 100).toFixed(1) + "%" : "no bet to call"],
      ["EV of calling", callEV != null ? fmtChips(callEV) : "—"],
      ["EV of folding", fmtChips(foldEV)],
      ["Recommended", verdict + (call > 0 && eq != null ? "  (" + (eq >= breakeven ? "+" : "") + fmtChips(callEV) + " vs fold)" : "")],
      ["SPR", spr != null ? spr.toFixed(1) : "—"],
      ["Effective stack", fmtChips(effStack) + " (villain stacks unknown)"],
      ["Opponent range source", "Uniform / random opponents"],
      ["Confidence", confidence],
    ];
    if (!advanced) rows = rows.filter(function (r) {
      return ["Equity vs random", "Break-even (pot odds)", "EV of calling", "Recommended", "SPR"].indexOf(r[0]) >= 0;
    });

    var table = h("div", "hud-readout");
    rows.forEach(function (r) {
      var row = h("div", "hud-readout-row");
      row.appendChild(h("span", "hud-readout-k", { text: r[0] }));
      row.appendChild(h("span", "hud-readout-v", { text: r[1] }));
      table.appendChild(row);
    });
    el.appendChild(table);

    var assume = h("ul", "hud-assumptions");
    [
      "Advisory only — no site data is read and no action is taken.",
      "EV is a one-street chip estimate (no future betting).",
      "Opponents modelled as uniform random hands unless you use the app's Advanced range mode.",
      "Single 52-card deck; hero equity from " + confidence + ".",
    ].forEach(function (a) { assume.appendChild(h("li", null, { text: a })); });
    if (advanced) el.appendChild(labeled("Assumptions", assume));

    if (warnings.length) {
      var wl = h("div", "hud-warnbox");
      warnings.forEach(function (w) { wl.appendChild(h("div", "hud-warn", { text: w })); });
      el.appendChild(wl);
    }

    setStatusLight(eq == null ? "idle" : (eq >= (call > 0 ? breakeven : 0.5) ? "go" : "hold"));
  }

  function labeled(label, node) {
    var wrap = h("div", "hud-labeled");
    wrap.appendChild(h("div", "hud-labeled-h", { text: label }));
    wrap.appendChild(node);
    return wrap;
  }
  function fmtChips(v) {
    if (v == null || isNaN(v)) return "—";
    var r = Math.round(v * 10) / 10;
    return (r >= 0 ? "" : "") + r;
  }

  // ================= unmount (clean revert) =================================
  function unmount() {
    if (!HUD.mounted) return;
    // Run every registered teardown (listeners, observers, worker).
    HUD.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    HUD.cleanup = [];
    if (HUD.host && HUD.host.parentNode) HUD.host.parentNode.removeChild(HUD.host);
    HUD.host = null; HUD.root = null; HUD.boxes = {}; HUD.taskbar = null;
    HUD.worker = null; HUD.inputs = {}; HUD._pending = null;
    HUD.mounted = false;
    // Leave no residue: the only global we keep is the toggle entry point.
  }

  function toggle() { if (HUD.mounted) unmount(); else mount(); }

  window.PokerHUD = { toggle: toggle, mount: mount, unmount: unmount, isMounted: function () { return HUD.mounted; } };
})();
