/*
 * app.js - UI, state and orchestration for the Poker Assistant.
 * Owns the poker-table view, the card picker, and dispatching equity jobs to
 * the Web Worker (with a synchronous fallback).
 */
(function () {
  "use strict";
  var P = window.Poker;

  // ---------- State ----------
  var state = {
    numPlayers: 6,
    decks: 1,
    handsBeforeShuffle: 1,
    handsPlayed: 0,
    trials: 40000,
    heroIndex: 0,
    pot: 0,
    toCall: 0,
    board: [null, null, null, null, null], // slot -> card id or null (unknown)
    dead: [],                               // mucked cards, removed until shuffle
    players: [],                            // { name, cards:[id|null,id|null], active, stack }
    lastResults: null,
  };

  function defaultName(i) { return "Player " + (i + 1); }

  function ensurePlayers() {
    while (state.players.length < state.numPlayers) {
      var i = state.players.length;
      state.players.push({ name: defaultName(i), cards: [null, null], active: true, stack: 1000 });
    }
    state.players.length = state.numPlayers;
    if (state.heroIndex >= state.numPlayers) state.heroIndex = 0;
  }

  // ---------- DOM refs ----------
  var $ = function (id) { return document.getElementById(id); };
  var tableEl = $("table"), communityEl = $("community"),
      potDisplay = $("pot-display"), deckInfo = $("deck-info"),
      simStatus = $("sim-status");
  var pickerEl = $("picker"), pickerGrid = $("picker-grid"), pickerTitle = $("picker-title");

  // ---------- Worker ----------
  var worker = null, jobId = 0, pendingId = 0;
  try {
    worker = new Worker("js/worker.js");
    worker.onmessage = function (e) {
      if (e.data.id !== pendingId) return; // ignore stale
      applyResults(e.data.result);
    };
    worker.onerror = function () { worker = null; };
  } catch (err) { worker = null; }

  function runSimulation(cfg) {
    pendingId = ++jobId;
    if (worker) {
      worker.postMessage({ id: pendingId, cfg: cfg });
    } else {
      // Synchronous fallback (e.g. opened directly from file://).
      var myId = pendingId;
      setTimeout(function () {
        var res = P.simulate(cfg);
        if (myId === pendingId) applyResults(res);
      }, 0);
    }
  }

  // ---------- Helpers ----------
  function knownCards(player) {
    return player.cards.filter(function (c) { return c !== null; });
  }
  function allUsedCards(excludeRef) {
    // Every card currently placed anywhere (for duplicate/availability checks).
    var used = [];
    state.board.forEach(function (c) { if (c !== null) used.push(c); });
    state.players.forEach(function (p) {
      p.cards.forEach(function (c) { if (c !== null) used.push(c); });
    });
    state.dead.forEach(function (c) { used.push(c); });
    if (excludeRef && excludeRef.current !== null && excludeRef.current !== undefined) {
      var i = used.indexOf(excludeRef.current);
      if (i >= 0) used.splice(i, 1);
    }
    return used;
  }
  function usedCount(cardId, excludeRef) {
    var used = allUsedCards(excludeRef);
    var n = 0;
    for (var i = 0; i < used.length; i++) if (used[i] === cardId) n++;
    return n;
  }

  // ---------- Card rendering ----------
  function cardFace(id) {
    var r = P.rankOf(id), s = P.suitOf(id);
    var el = document.createElement("div");
    el.className = "card " + P.SUIT_COLOR[s];
    el.innerHTML =
      '<div class="corner"><div class="r">' + P.RANK_LABEL[r] + "</div><div>" +
      P.SUIT_SYMBOL[s] + '</div></div><div class="pip">' + P.SUIT_SYMBOL[s] + "</div>";
    return el;
  }
  function cardBack() {
    var el = document.createElement("div");
    el.className = "card back";
    return el;
  }
  function emptySlot() {
    var el = document.createElement("div");
    el.className = "slot";
    el.textContent = "+";
    return el;
  }

  // ---------- Seat geometry ----------
  function seatPositions(n) {
    // Hero at bottom-centre (i=0), others spread evenly around the ellipse.
    // Tighter horizontal radius on phones keeps side seats fully on-screen.
    var narrow = window.matchMedia("(max-width: 700px)").matches;
    var xR = narrow ? 38 : 44, yR = narrow ? 34 : 40;
    var pos = [];
    for (var i = 0; i < n; i++) {
      var theta = (Math.PI / 2) + (i * 2 * Math.PI / n); // radians, 0 = right, +y down
      pos.push({ x: 50 + xR * Math.cos(theta), y: 50 + yR * Math.sin(theta) });
    }
    return pos;
  }

  // ---------- Render ----------
  function render() {
    ensurePlayers();

    // Community cards.
    communityEl.innerHTML = "";
    for (var b = 0; b < 5; b++) {
      var slot;
      if (state.board[b] !== null) {
        slot = cardFace(state.board[b]);
      } else {
        slot = emptySlot();
      }
      slot.addEventListener("click", makeOpener("board", null, b));
      communityEl.appendChild(slot);
    }

    // Pot + deck.
    potDisplay.textContent = "Pot " + state.pot + (state.toCall > 0 ? " · to call " + state.toCall : "");
    var totalCards = 52 * state.decks;
    var remaining = totalCards - allUsedCards().length;
    deckInfo.textContent = remaining + " cards live · " + state.decks + " deck" +
      (state.decks > 1 ? "s" : "") + (state.dead.length ? " · " + state.dead.length + " mucked" : "");

    // Seats.
    tableEl.querySelectorAll(".seat").forEach(function (s) { s.remove(); });
    var pos = seatPositions(state.numPlayers);
    state.players.forEach(function (player, idx) {
      var seat = document.createElement("div");
      seat.className = "seat" + (idx === state.heroIndex ? " hero" : "") + (player.active ? "" : " folded");
      seat.style.left = pos[idx].x + "%";
      seat.style.top = pos[idx].y + "%";

      // Top row: name + controls.
      var top = document.createElement("div");
      top.className = "seat-top";
      var name = document.createElement("input");
      name.className = "seat-name"; name.value = player.name; name.spellcheck = false;
      name.addEventListener("input", function () { player.name = name.value; });
      var badges = document.createElement("div");
      badges.className = "seat-badges";
      var heroBtn = miniBtn("⌂", idx === state.heroIndex, "Mark this seat as you", function () {
        state.heroIndex = idx; syncStackInput(); scheduleAndRender();
      });
      var foldBtn = miniBtn(player.active ? "✓" : "✕", player.active, player.active ? "Active — click to fold" : "Folded — click to reactivate", function () {
        player.active = !player.active; scheduleAndRender();
      });
      badges.appendChild(heroBtn); badges.appendChild(foldBtn);
      top.appendChild(name); top.appendChild(badges);
      seat.appendChild(top);

      // Cards.
      var cardsRow = document.createElement("div");
      cardsRow.className = "seat-cards";
      for (var c = 0; c < 2; c++) {
        var el;
        if (player.cards[c] !== null) {
          el = cardFace(player.cards[c]); el.classList.add("small");
        } else if (idx === state.heroIndex) {
          el = emptySlot(); el.classList.add("small");
        } else {
          el = cardBack(); el.classList.add("small");
        }
        el.addEventListener("click", makeOpener("player", idx, c));
        cardsRow.appendChild(el);
      }
      seat.appendChild(cardsRow);

      // Win probability bar.
      var bar = document.createElement("div");
      bar.className = "winbar";
      var res = state.lastResults && state.lastResults[idx];
      var wp = res ? res.equity : 0;
      bar.innerHTML = '<span style="width:' + (wp * 100).toFixed(1) + '%"></span><b>' +
        (player.active ? (res ? (wp * 100).toFixed(1) + "%" : "—") : "folded") + "</b>";
      seat.appendChild(bar);

      // Foot: stack + YOU tag.
      var foot = document.createElement("div");
      foot.className = "seat-foot";
      var stack = document.createElement("input");
      stack.className = "seat-stack"; stack.type = "number"; stack.min = "0";
      stack.setAttribute("inputmode", "numeric");
      stack.value = player.stack;
      stack.addEventListener("input", function () {
        player.stack = Math.max(0, parseInt(stack.value || "0", 10));
        if (idx === state.heroIndex) syncStackInput();
        scheduleCompute();
      });
      foot.appendChild(stack);
      if (idx === state.heroIndex) {
        var tag = document.createElement("span");
        tag.className = "you-tag"; tag.textContent = "YOU";
        foot.appendChild(tag);
      }
      seat.appendChild(foot);

      tableEl.appendChild(seat);
    });
  }

  function miniBtn(label, on, title, onClick) {
    var b = document.createElement("button");
    b.className = "mini-btn" + (on ? " on" : "");
    b.textContent = label; b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  // ---------- Card picker ----------
  var pickerTarget = null; // { type:'board'|'player', index, slot }
  function makeOpener(type, index, slot) {
    return function (e) { e.stopPropagation(); openPicker(type, index, slot); };
  }
  function currentCardOf(target) {
    if (target.type === "board") return state.board[target.slot];
    return state.players[target.index].cards[target.slot];
  }
  function openPicker(type, index, slot) {
    pickerTarget = { type: type, index: index, slot: slot };
    var where = type === "board"
      ? "community card " + (slot + 1)
      : (index === state.heroIndex ? "your" : state.players[index].name + "'s") + " card " + (slot + 1);
    pickerTitle.textContent = "Choose " + where;
    buildPickerGrid();
    pickerEl.hidden = false;
    document.body.classList.add("picker-open");
  }
  function closePicker() {
    pickerEl.hidden = true; pickerTarget = null;
    document.body.classList.remove("picker-open");
  }

  var pickerBox = document.querySelector(".picker");
  var pickerSuit = 3; // remembered suit for the mobile two-step picker
  function isMobile() { return window.matchMedia("(max-width: 700px)").matches; }

  function buildPickerGrid() {
    // Clear any previous suit selector.
    var oldSeg = pickerBox.querySelector(".suit-seg");
    if (oldSeg) oldSeg.remove();
    pickerGrid.innerHTML = "";
    var excludeRef = { current: currentCardOf(pickerTarget) };

    function pickButton(rank, suit, big) {
      var id = P.makeId(rank, suit);
      var btn = document.createElement("button");
      btn.className = "pick " + P.SUIT_COLOR[suit];
      btn.innerHTML = big
        ? P.RANK_LABEL[rank] + '<span style="font-size:.7em"> ' + P.SUIT_SYMBOL[suit] + "</span>"
        : P.RANK_LABEL[rank] + "<br>" + P.SUIT_SYMBOL[suit];
      if (state.decks - usedCount(id, excludeRef) <= 0) btn.disabled = true;
      btn.addEventListener("click", function () { assignCard(id); });
      return btn;
    }

    if (isMobile()) {
      // Two-step: choose a suit, then a rank with large targets.
      pickerBox.classList.add("two-step");
      var cur = currentCardOf(pickerTarget);
      if (cur !== null && cur !== undefined) pickerSuit = P.suitOf(cur);
      var seg = document.createElement("div");
      seg.className = "suit-seg";
      P.SUITS.forEach(function (suit) {
        var b = document.createElement("button");
        b.className = P.SUIT_COLOR[suit] + (suit === pickerSuit ? " active" : "");
        b.textContent = P.SUIT_SYMBOL[suit];
        b.setAttribute("aria-label", P.SUIT_NAME[suit]);
        b.addEventListener("click", function () { pickerSuit = suit; buildPickerGrid(); });
        seg.appendChild(b);
      });
      pickerBox.insertBefore(seg, pickerGrid);
      P.RANKS.forEach(function (rank) { pickerGrid.appendChild(pickButton(rank, pickerSuit, true)); });
    } else {
      pickerBox.classList.remove("two-step");
      // Rows = suits, columns = ranks (matches a real deck layout).
      P.SUITS.forEach(function (suit) {
        P.RANKS.forEach(function (rank) { pickerGrid.appendChild(pickButton(rank, suit, false)); });
      });
    }
  }
  function assignCard(id) {
    if (pickerTarget.type === "board") state.board[pickerTarget.slot] = id;
    else state.players[pickerTarget.index].cards[pickerTarget.slot] = id;
    closePicker(); scheduleAndRender();
  }
  function clearSlot() {
    if (!pickerTarget) return;
    if (pickerTarget.type === "board") state.board[pickerTarget.slot] = null;
    else state.players[pickerTarget.index].cards[pickerTarget.slot] = null;
    closePicker(); scheduleAndRender();
  }

  // ---------- Compute + results ----------
  var computeTimer = null;
  function scheduleCompute() {
    if (computeTimer) clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, 140);
  }
  function scheduleAndRender() { render(); scheduleCompute(); }

  function compute() {
    // Need at least the two hole cards of an active hero to give advice, but
    // odds can be computed for any 2+ active players.
    var activePlayers = state.players.filter(function (p) { return p.active; });
    if (activePlayers.length < 2) {
      simStatus.textContent = "Need at least two active players.";
      return;
    }
    var cfg = {
      players: state.players.map(function (p) {
        return { cards: knownCards(p), active: p.active };
      }),
      board: state.board.filter(function (c) { return c !== null; }),
      decks: state.decks,
      dead: state.dead.slice(),
      trials: state.trials,
    };
    simStatus.textContent = "Calculating…";
    runSimulation(cfg);
  }

  function applyResults(result) {
    if (!result || !result.ok) {
      simStatus.textContent = result && result.error ? result.error : "Could not compute.";
      state.lastResults = null;
      render();
      return;
    }
    state.lastResults = result.results;
    // Update win bars in place.
    updateWinBars();
    // Status line.
    var modeTxt = result.mode === "exact"
      ? "Exact enumeration of all runouts"
      : result.trials.toLocaleString() + " simulations";
    simStatus.textContent = modeTxt + " · " + (result.ms || 0) + " ms · " + result.poolSize + " cards in deck";
    updateRecommendation();
  }

  function updateWinBars() {
    var seats = tableEl.querySelectorAll(".seat");
    state.players.forEach(function (player, idx) {
      var seat = seats[idx];
      if (!seat) return;
      var bar = seat.querySelector(".winbar");
      var res = state.lastResults && state.lastResults[idx];
      var wp = res ? res.equity : 0;
      bar.querySelector("span").style.width = (wp * 100).toFixed(1) + "%";
      bar.querySelector("b").textContent = player.active
        ? (res ? (wp * 100).toFixed(1) + "%" : "—") : "folded";
    });
  }

  // ---------- Recommendation ----------
  function updateRecommendation() {
    var hero = state.players[state.heroIndex];
    var recCard = $("rec-card"), headline = $("rec-headline"),
        handEl = $("rec-hand"), reasonsEl = $("rec-reasons"), statsEl = $("rec-stats");

    if (!hero.active) {
      setRec("neutral", "You have folded", "", ["Reactivate your seat (✓) to get advice."], null);
      return;
    }
    var res = state.lastResults && state.lastResults[state.heroIndex];
    if (!res) { setRec("neutral", "Add your cards", "", ["Click your seat's cards to enter your hand."], null); return; }
    if (knownCards(hero).length < 2) {
      setRec("neutral", (res.equity * 100).toFixed(1) + "% to win", "",
        ["Enter both of your hole cards for a betting recommendation.",
         "Current number is an average over all hands you could be holding."], res);
      return;
    }

    var adv = P.advise({
      equity: res.equity,
      pot: state.pot,
      toCall: state.toCall,
      stack: hero.stack,
    });

    // Best made hand right now (hero cards + known board).
    var handLabel = "";
    var board = state.board.filter(function (c) { return c !== null; });
    if (board.length >= 3) {
      var seven = knownCards(hero).concat(board);
      handLabel = "Currently: " + P.handName(P.evaluate7(seven));
    }

    setRec(adv.tone, adv.headline, handLabel, adv.reasons, res, adv.stats);
  }

  function setRec(tone, headline, handLabel, reasons, res, stats) {
    var recCard = $("rec-card");
    recCard.className = "rec-card " + tone;
    $("rec-headline").textContent = headline;
    $("rec-hand").textContent = handLabel || "";
    var reasonsEl = $("rec-reasons");
    reasonsEl.innerHTML = "";
    (reasons || []).forEach(function (r) {
      var li = document.createElement("li"); li.textContent = r; reasonsEl.appendChild(li);
    });
    var statsEl = $("rec-stats");
    statsEl.innerHTML = "";
    if (res) {
      addStat(statsEl, "Win", (res.win * 100).toFixed(1) + "%");
      addStat(statsEl, "Tie", (res.tie * 100).toFixed(1) + "%");
    }
    if (stats) {
      addStat(statsEl, "Pot odds need", (stats.breakEven * 100).toFixed(1) + "%");
      addStat(statsEl, "EV of calling", (Math.round(stats.evCall) >= 0 ? "+" : "") + Math.round(stats.evCall) + " chips");
      addStat(statsEl, "Kelly stake", Math.max(0, Math.min(1, stats.kelly)) * 100 > 0
        ? (Math.max(0, Math.min(1, stats.kelly)) * 100).toFixed(0) + "% of stack" : "0%");
    }
    // Mirror onto the mobile bottom bar.
    var bar = $("rec-bar");
    bar.className = "rec-bar " + tone;
    $("rec-bar-action").textContent = headline;
    $("rec-bar-sub").textContent = res
      ? (handLabel ? handLabel.replace("Currently: ", "") : "Tap for full advice")
      : "Tap for advice & settings";
    $("rec-bar-eq").textContent = res ? (res.equity * 100).toFixed(0) + "%" : "";
  }
  function addStat(parent, k, v) {
    var d = document.createElement("div"); d.className = "stat";
    d.innerHTML = '<div class="k">' + k + '</div><div class="v">' + v + "</div>";
    parent.appendChild(d);
  }

  // ---------- Hand lifecycle ----------
  function collectTableCards() {
    var cards = [];
    state.board.forEach(function (c) { if (c !== null) cards.push(c); });
    state.players.forEach(function (p) {
      p.cards.forEach(function (c) { if (c !== null) cards.push(c); });
    });
    return cards;
  }
  function clearTable() {
    state.board = [null, null, null, null, null];
    state.players.forEach(function (p) { p.cards = [null, null]; p.active = true; });
    state.lastResults = null;
  }
  function nextHand() {
    // Cards seen this hand stay dead in the shoe until a shuffle.
    state.dead = state.dead.concat(collectTableCards());
    state.handsPlayed++;
    clearTable();
    if (state.handsPlayed >= state.handsBeforeShuffle) shuffle();
    else { updateShoeHint(); scheduleAndRender(); }
  }
  function shuffle() {
    state.dead = [];
    state.handsPlayed = 0;
    clearTable();
    updateShoeHint();
    scheduleAndRender();
  }
  function updateShoeHint() {
    var h = state.handsBeforeShuffle;
    $("shoe-hint").textContent = h <= 1
      ? "Deck is shuffled every hand — no cards carry over."
      : "Hand " + (state.handsPlayed + 1) + " of " + h + " before the next shuffle. " +
        state.dead.length + " card(s) already dealt this shoe are removed from the odds.";
  }

  // ---------- Inputs ----------
  function syncStackInput() { $("in-stack").value = state.players[state.heroIndex].stack; }

  function bindInputs() {
    $("in-pot").addEventListener("input", function () {
      state.pot = Math.max(0, parseInt(this.value || "0", 10)); potDisplay.textContent =
        "Pot " + state.pot + (state.toCall > 0 ? " · to call " + state.toCall : "");
      updateRecommendation();
    });
    $("in-call").addEventListener("input", function () {
      state.toCall = Math.max(0, parseInt(this.value || "0", 10));
      potDisplay.textContent = "Pot " + state.pot + (state.toCall > 0 ? " · to call " + state.toCall : "");
      updateRecommendation();
    });
    $("in-stack").addEventListener("input", function () {
      state.players[state.heroIndex].stack = Math.max(0, parseInt(this.value || "0", 10));
      render(); updateRecommendation();
    });
    $("in-players").addEventListener("input", function () {
      state.numPlayers = parseInt(this.value, 10);
      $("players-val").textContent = state.numPlayers;
      scheduleAndRender();
    });
    $("in-decks").addEventListener("input", function () {
      state.decks = parseInt(this.value, 10);
      $("decks-val").textContent = state.decks;
      scheduleAndRender();
    });
    $("in-shuffle").addEventListener("input", function () {
      state.handsBeforeShuffle = parseInt(this.value, 10);
      $("shuffle-val").textContent = state.handsBeforeShuffle;
      updateShoeHint();
    });
    $("in-quality").addEventListener("change", function () {
      state.trials = parseInt(this.value, 10); scheduleCompute();
    });

    $("btn-next-hand").addEventListener("click", nextHand);
    $("btn-shuffle").addEventListener("click", shuffle);
    $("btn-reset").addEventListener("click", function () { clearTable(); scheduleAndRender(); });

    $("picker-close").addEventListener("click", closePicker);
    $("picker-facedown").addEventListener("click", clearSlot);
    $("picker-clear").addEventListener("click", clearSlot);
    pickerEl.addEventListener("click", function (e) { if (e.target === pickerEl) closePicker(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closePicker(); closeSheet(); } });

    bindSheet();
  }

  // ---------- Mobile bottom sheet (advice + settings) ----------
  function openSheet() {
    $("panel").classList.add("open");
    $("sheet-backdrop").hidden = false;
    document.body.classList.add("sheet-open");
  }
  function closeSheet() {
    $("panel").classList.remove("open");
    $("sheet-backdrop").hidden = true;
    document.body.classList.remove("sheet-open");
  }
  function bindSheet() {
    $("rec-bar").addEventListener("click", openSheet);
    $("sheet-close").addEventListener("click", closeSheet);
    $("sheet-backdrop").addEventListener("click", closeSheet);

    // Mobile table actions (mirrors of the desktop top-bar buttons).
    $("m-next-hand").addEventListener("click", nextHand);
    $("m-shuffle").addEventListener("click", shuffle);
    $("m-reset").addEventListener("click", function () { clearTable(); scheduleAndRender(); });

    // Swipe the sheet down to dismiss.
    var panel = $("panel"), startY = null;
    panel.addEventListener("touchstart", function (e) {
      startY = panel.scrollTop <= 0 ? e.touches[0].clientY : null;
    }, { passive: true });
    panel.addEventListener("touchmove", function (e) {
      if (startY === null) return;
      var dy = e.touches[0].clientY - startY;
      panel.style.transform = dy > 0 ? "translateY(" + dy + "px)" : "";
    }, { passive: true });
    panel.addEventListener("touchend", function (e) {
      if (startY === null) return;
      var dy = e.changedTouches[0].clientY - startY;
      panel.style.transform = "";
      if (dy > 90) closeSheet();
      startY = null;
    });

    // Re-render when the viewport crosses the mobile breakpoint (seat geometry
    // and the picker layout both depend on it).
    var mq = window.matchMedia("(max-width: 700px)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(function () {
      render();
      if (state.lastResults) updateWinBars();
      if (pickerTarget) buildPickerGrid();
    });
  }

  // ---------- Init ----------
  function init() {
    ensurePlayers();
    bindInputs();
    syncStackInput();
    updateShoeHint();
    render();
    scheduleCompute();
  }
  init();
})();
