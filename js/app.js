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
    reshuffleEveryHand: true,               // fresh full deck each hand (Next hand = Shuffle)
    handsBeforeShuffle: 1,
    handsPlayed: 0,
    trials: 40000,
    heroIndex: 0,
    pot: 0,
    toCall: 0,
    toCallPending: false,   // watch sees a bet on the call button but can't read the amount yet
    board: [null, null, null, null, null], // slot -> card id or null (unknown)
    dead: [],                               // mucked cards, removed until shuffle
    players: [],                            // { name, cards:[id|null,id|null], active, stack }
    dealer: null,                           // seat index with the dealer button (for position)
    lastResults: null,
    // Advanced range-EV mode.
    advanced: false,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    potDisplayMode: "includes-current-bets",
    gameMode: "play-money",   // play-money | cash | tournament (rake only in cash)
    rakePercent: 0,           // e.g. 0.05 for 5%
    rakeCap: 0,               // 0 = uncapped
    rangeSource: "uniform",
    manualRange: "QQ+, AK, AQs, AJs, KQs",
    population: "default",     // opponent-pool baseline priors (Wave 0.3)
    heroRangeSource: "none",   // range-vs-range analysis (Wave 1.1)
    heroRangeText: "QQ+, AK, AQs, KQs, JTs",
  };

  function defaultName(i) { return "Player " + (i + 1); }

  function ensurePlayers() {
    while (state.players.length < state.numPlayers) {
      var i = state.players.length;
      state.players.push({ name: defaultName(i), cards: [null, null], active: true, stack: 1000, bet: 0 });
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
  // Job ids are tracked per channel so a strategy job never clobbers the uniform
  // equity job (and each channel ignores its own stale results).
  var worker = null, jobId = 0, pendingId = 0, pendingStrategyId = 0, pendingRvrId = 0;
  try {
    worker = new Worker("js/worker.js");
    worker.onmessage = function (e) {
      var d = e.data || {};
      if (d.id === pendingId) applyResults(d.result);
      else if (d.id === pendingStrategyId) applyStrategy(d.result);
      else if (d.id === pendingRvrId) applyRvr(d.result);
    };
    worker.onerror = function () { worker = null; };
  } catch (err) { worker = null; }

  function runSimulation(cfg) {
    pendingId = ++jobId;
    if (worker) {
      worker.postMessage({ id: pendingId, type: "simulate", cfg: cfg });
    } else {
      var myId = pendingId;
      setTimeout(function () {
        var res = P.simulate(cfg);
        if (myId === pendingId) applyResults(res);
      }, 0);
    }
  }

  function runStrategy(cfg) {
    pendingStrategyId = ++jobId;
    if (worker) {
      worker.postMessage({ id: pendingStrategyId, type: "strategy", cfg: cfg });
    } else {
      var myId = pendingStrategyId;
      setTimeout(function () {
        var res = P.Strategy.rangeRecommend(cfg);
        if (myId === pendingStrategyId) applyStrategy(res);
      }, 0);
    }
  }

  function runRvr(cfg) {
    pendingRvrId = ++jobId;
    if (worker) {
      worker.postMessage({ id: pendingRvrId, type: "rvr", cfg: cfg });
    } else {
      var myId = pendingRvrId;
      setTimeout(function () {
        var res = P.RangeVsRange.analyze(cfg);
        if (myId === pendingRvrId) applyRvr(res);
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
    // On phones seats shrink as the table fills, so we can push the ring out
    // toward the rim for more spacing without clipping or centre overlap.
    var narrow = window.matchMedia("(max-width: 700px)").matches;
    var xR = 44, yR = 40;
    if (narrow) {
      if (n <= 4) { xR = 39; yR = 36; }
      else if (n <= 6) { xR = 40; yR = 38; }
      else if (n <= 8) { xR = 41; yR = 39; }
      else { xR = 42; yR = 40; }
    }
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

    // Scale the seats to the table size on phones (more players → smaller seats).
    if (window.matchMedia("(max-width: 700px)").matches) {
      var n = state.numPlayers;
      tableEl.setAttribute("data-seat",
        n <= 4 ? "lg" : n <= 6 ? "md" : n <= 8 ? "sm" : "xs");
    } else {
      tableEl.removeAttribute("data-seat");
    }

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
      var dealerBtn = miniBtn("D", idx === state.dealer, "Mark the dealer button (sets table position)", function () {
        state.dealer = (state.dealer === idx) ? null : idx; scheduleAndRender();
      });
      badges.appendChild(heroBtn); badges.appendChild(foldBtn); badges.appendChild(dealerBtn);
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

      // Current bet in front of this player (from Watch's bet boxes).
      if (idx !== state.heroIndex && player.bet > 0) {
        var betChip = document.createElement("div");
        betChip.className = "seat-bet";
        betChip.textContent = "Bet " + player.bet.toLocaleString();
        seat.appendChild(betChip);
      }

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
    scheduleAdvanced();
  }

  // ---------- Advanced range-EV strategy ----------
  var advTimer = null;
  function scheduleAdvanced() {
    if (advTimer) clearTimeout(advTimer);
    advTimer = setTimeout(computeAdvanced, 160);
  }

  function positionOfSeat(seatIndex) {
    // Position label from the dealer button, over the CURRENTLY active seats.
    if (state.dealer == null) return null;
    var active = [];
    for (var i = 0; i < state.numPlayers; i++) if (state.players[i].active) active.push(i);
    if (active.length < 2) return null;
    var order = ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "MP+1", "HJ", "CO"];
    // Walk clockwise from the button across active seats.
    var seq = [];
    for (var step = 0; step < state.numPlayers; step++) {
      var s = (state.dealer + step) % state.numPlayers;
      if (state.players[s].active) seq.push(s);
    }
    if (seq.length === 2) { // heads-up
      return seatIndex === seq[0] ? "BTN" : "BB";
    }
    var idx = seq.indexOf(seatIndex);
    if (idx < 0) return null;
    return order[Math.min(idx, order.length - 1)];
  }

  // Context for the equity-realization heuristic (#1): street, position, SPR and
  // whether the hero holds a draw / strong made hand. Initiative is unknown
  // (we don't track a chronological action stream), so it stays neutral.
  function heroRealizationCtx() {
    var boardArr = state.board.filter(function (c) { return c !== null; });
    var street = boardArr.length >= 5 ? "river" : boardArr.length === 4 ? "turn" : boardArr.length === 3 ? "flop" : "preflop";
    var pos = positionOfSeat(state.heroIndex);
    var inPosition = pos == null ? null : (pos === "BTN" || pos === "CO" || pos === "BTN/SB");
    var pot = canonicalPotForAdvanced();
    var hero = state.players[state.heroIndex];
    var spr = pot > 0 && hero ? hero.stack / pot : 3;
    var draw = false, madeStrong = false;
    if (P.HandFeatures && boardArr.length >= 3) {
      var f = P.HandFeatures.extract(knownCards(hero), boardArr);
      draw = !!(f.flush && (f.flush.flushDraw || f.comboDraw)) || !!(f.straight && (f.straight.oesd || f.straight.gutshot || f.straight.doubleGutshot));
      madeStrong = !!(f.made && f.made.category >= P.CATEGORY.TWO_PAIR);
      if (madeStrong) draw = false; // a strong made hand isn't "a draw"
    }
    return { street: street, inPosition: inPosition, hasInitiative: null, spr: spr, draw: draw, madeStrong: madeStrong };
  }

  function buildOpponentRange(seatIndex) {
    var Ranges = P.Ranges;
    var blockers = allUsedCards();
    var base, source;
    if (state.rangeSource === "manual") {
      var parsed = Ranges.parse(state.manualRange || "");
      if (!parsed.ok || !parsed.range.length) { base = Ranges.fullRange(); source = "uniform (manual range invalid: " + (parsed.error || "empty") + ")"; }
      else { base = parsed.range; source = "manual range"; }
    } else if (state.rangeSource === "position") {
      var pos = positionOfSeat(seatIndex);
      var prior = P.RangePresets.priorFor({ position: pos });
      base = prior.range; source = prior.source;
    } else {
      base = Ranges.fullRange(); source = "uniform (versus random hands)";
    }
    var cleaned = Ranges.normalise(Ranges.removeBlockers(base, blockers));
    return { range: cleaned, source: source };
  }

  function computeAdvanced() {
    var card = $("strategy-card");
    if (!state.advanced) { if (card) card.hidden = true; return; }
    if (!card) return;
    card.hidden = false;
    var hero = state.players[state.heroIndex];

    if (state.decks > 1) {
      renderStrategyMessage("Range strategy is one-deck only",
        ["Advanced range modelling is disabled for more than one deck.",
         "Switch decks back to 1, or use Simple mode's uniform equity."]);
      return;
    }
    if (!hero || knownCards(hero).length < 2) {
      renderStrategyMessage("Enter both hero cards", ["Range/EV strategy needs your exact two cards."]);
      return;
    }
    var opponents = [];
    for (var i = 0; i < state.numPlayers; i++) {
      if (i === state.heroIndex || !state.players[i].active) continue;
      var built = buildOpponentRange(i);
      if (!built.range.length) continue;
      opponents.push({ seatId: i, range: built.range, source: built.source });
    }
    if (!opponents.length) {
      renderStrategyMessage("No active opponents", ["Add at least one active opponent to model a range."]);
      return;
    }

    var P0 = canonicalPotForAdvanced();
    var C0 = Math.max(0, state.toCall || 0);
    var dc = {
      heroCards: knownCards(hero),
      board: state.board.filter(function (c) { return c !== null; }),
      deadCards: state.dead.slice(),
      P: P0, C: C0,
      heroStreetCommitted: 0,
      heroStackBehind: hero.stack,
      currentBetTo: C0,
      lastFullRaiseSize: state.bigBlind || 0,
      bigBlind: state.bigBlind || 0,
      opponents: opponents,
      trials: Math.min(state.trials, 40000),
      // Rake only bites in cash mode; play-money/tournament pass 0 via ActionEV.
      mode: state.gameMode,
      rakePercent: state.rakePercent,
      rakeCap: state.rakeCap,
      population: state.population,
    };
    $("strat-headline").textContent = "Calculating range EV…";
    runStrategy(dc);
    computeRvr(opponents, hero, dc.board, dc.deadCards, P0, C0);
  }

  var rvrPot = 0, rvrToCall = 0; // canonical pot + call captured for the range-vs-range plan/defense

  // Range-vs-range analysis (Wave 1.1): how the hero's whole range performs on
  // this board, where the hero's actual hand ranks within it, and (heads-up)
  // the range/nut advantage. Analysis only - it never changes the EV advice.
  function buildHeroRange() {
    var Ranges = P.Ranges;
    // The hero's own cards belong IN the hero range, so they must not block it.
    // Block only the board, dead cards and any other players' known cards.
    var blockers = allUsedCards();
    knownCards(state.players[state.heroIndex]).forEach(function (hc) {
      var i = blockers.indexOf(hc);
      if (i >= 0) blockers.splice(i, 1);
    });
    var base, source;
    if (state.heroRangeSource === "manual") {
      var parsed = Ranges.parse(state.heroRangeText || "");
      if (!parsed.ok || !parsed.range.length) return { range: [], source: "invalid: " + (parsed.error || "empty") };
      base = parsed.range; source = "manual";
    } else if (state.heroRangeSource === "position") {
      var pos = positionOfSeat(state.heroIndex);
      var prior = P.RangePresets.priorFor({ position: pos });
      base = prior.range; source = prior.source;
    } else {
      base = Ranges.fullRange(); source = "uniform";
    }
    // Keep the hero's ACTUAL hand in the range so it can be located, but remove
    // board/dead blockers.
    return { range: Ranges.normalise(Ranges.removeBlockers(base, blockers)), source: source };
  }

  function computeRvr(opponents, hero, board, dead, pot, toCall) {
    rvrPot = pot || 0;
    rvrToCall = toCall || 0;
    var card = $("rvr-card");
    if (!card) return;
    if (state.heroRangeSource === "none") { card.hidden = true; return; }
    var built = buildHeroRange();
    if (!built.range.length) { card.hidden = false; renderRvrMessage("Your range is empty or invalid."); return; }
    card.hidden = false;
    $("rvr-stats").innerHTML = "";
    $("rvr-note").textContent = "Analysing your range on this board…";
    var oppRanges = opponents.map(function (o) { return o.range; });
    runRvr({
      heroRange: built.range,
      opponentRanges: oppRanges,
      opponentRange: opponents.length === 1 ? opponents[0].range : null, // advantage only heads-up
      board: board, deadCards: dead,
      heroActual: knownCards(hero),
      trials: 1200, maxCombos: 120, seed: 1, exactLimit: 60000,
      _rangeSource: built.source,
    });
  }

  function renderRvrMessage(msg) {
    $("rvr-stats").innerHTML = "";
    $("rvr-note").textContent = msg;
  }

  function applyRvr(res) {
    if (!res) return;
    var card = $("rvr-card");
    if (state.heroRangeSource === "none") { card.hidden = true; return; }
    if (!res.ok) { renderRvrMessage(res.error || "Range-vs-range unavailable."); return; }
    var pct = function (x) { return (x * 100).toFixed(1) + "%"; };
    var h = res.heroDist;
    var stats = $("rvr-stats"); stats.innerHTML = "";
    addStat(stats, "Your range equity", pct(h.meanEquity));
    addStat(stats, "Nutted share", pct(h.nutFraction));
    if (h.heroActual) {
      addStat(stats, "Your hand", pct(h.heroActual.equity));
      addStat(stats, "In-range rank", pct(h.heroActual.percentile) + "ile");
    }
    if (res.advantage) {
      var a = res.advantage;
      addStat(stats, "Range edge", (a.equityEdge >= 0 ? "+" : "") + (a.equityEdge * 100).toFixed(1) + "%");
      addStat(stats, "Nut advantage", (a.nutAdvantage >= 0 ? "+" : "") + (a.nutAdvantage * 100).toFixed(1) + "%");
    }
    // GTO defense verdict (#5): facing a bet, MDF + the hero hand's in-range
    // percentile give a defend/fold call. Shown as a labelled equilibrium
    // verdict beside the EV recommendation (the EV table stays primary).
    if (P.GtoDefense && rvrToCall > 0 && h.heroActual && h.heroActual.percentile != null) {
      var gv = P.GtoDefense.defenseVerdict({ P: rvrPot, C: rvrToCall, heroPercentile: h.heroActual.percentile });
      if (gv) {
        var evAction = (lastStrategy && lastStrategy.action) || null;
        var rec = P.GtoDefense.reconcile(gv, evAction);
        var gd = document.createElement("div");
        gd.className = "rvr-plan gto-defense";
        var verdictTxt = gv.verdict === "defend" ? "DEFEND (call/raise)" : "FOLD";
        gd.innerHTML = '<div class="gto-title">Equilibrium defense (facing this bet)</div>' +
          '<div class="gto-row"><span>MDF (defend the top)</span><b>' + (gv.mdf * 100).toFixed(0) + "%</b></div>" +
          '<div class="gto-row"><span>Your hand ranks</span><b>' + (gv.heroPercentile * 100).toFixed(0) + "ile</b></div>" +
          '<div class="gto-row"><span>Equilibrium verdict</span><b class="role-' + (gv.verdict === "defend" ? "value" : "check") + '">' + verdictTxt + "</b></div>" +
          (rec.note ? '<div class="gto-note">' + rec.note + "</div>" : "");
        $("rvr-stats").appendChild(gd);
      }
    }

    // Polarised bet-composition plan (#7): where the hero's hand plays at a few
    // reference sizes, and the balanced value/bluff split of the whole range.
    var heroCards = knownCards(state.players[state.heroIndex]);
    if (P.BetComposition && rvrPot > 0 && h.combos && h.combos.length) {
      var oppCombos = res.oppDist && res.oppDist.combos ? res.oppDist.combos : null; // heads-up only
      var sizes = [{ label: "½ pot", B: 0.5 * rvrPot }, { label: "¾ pot", B: 0.75 * rvrPot }, { label: "pot", B: rvrPot }];
      var lines = sizes.map(function (s) {
        var pl = P.BetComposition.plan({ combos: h.combos, P: rvrPot, B: s.B, heroActual: heroCards, opponentCombos: oppCombos });
        if (!pl.ok) return null;
        var roleTxt = pl.heroRole ? pl.heroRole.toUpperCase() : "—";
        // Mixed-strategy frequency for the hero hand (#6): bet% vs check%.
        var freqTxt = "";
        if (pl.heroMix) {
          var bf = Math.round(pl.heroMix.betFreq * 100);
          if (pl.heroMix.kind === "value") freqTxt = "bet 100%";
          else if (pl.heroMix.kind === "bluff") freqTxt = "bet " + bf + "% / check " + (100 - bf) + "%";
          else freqTxt = "check 100%";
        }
        return { label: s.label, role: roleTxt, freq: freqTxt };
      }).filter(Boolean);
      if (lines.length) {
        var wrap = document.createElement("div");
        wrap.className = "rvr-plan";
        wrap.innerHTML = '<div class="gto-title">Balanced bet plan — your hand plays as' + (oppCombos ? " (blocker-aware bluffs)" : "") + "</div>" +
          lines.map(function (l) {
            return '<div class="gto-row"><span>' + l.label + '</span><b class="role-' + l.role.toLowerCase() + '">' + l.role + "</b>" +
              '<span class="plan-bluff">' + l.freq + "</span></div>";
          }).join("");
        $("rvr-stats").appendChild(wrap);
      }
    }

    var note = [];
    if (h.truncated) note.push("Range sampled (" + h.combosEvaluated + " combos) for speed.");
    note.push(res.advantage ? "Heads-up range/nut advantage on this board." : "Multiway: showing your range only (no pairwise advantage).");
    note.push("Balanced-range plan is a GTO approximation shown for comparison; the EV table is the recommendation.");
    $("rvr-note").textContent = note.join(" ");
  }

  function canonicalPotForAdvanced() {
    var pot = Math.max(0, state.pot || 0), toCall = Math.max(0, state.toCall || 0);
    switch (state.potDisplayMode) {
      case "excludes-current-bets": return pot + toCall; // add the bet hero faces
      case "manual-canonical": return pot;
      default: return pot; // includes-current-bets: hero has not yet added the call
    }
  }

  var lastStrategy = null; // last range-EV recommendation, for GTO-vs-EV reconciliation
  function applyStrategy(result) {
    if (!result) return;
    if (result.error) { lastStrategy = null; renderStrategyMessage("Range strategy unavailable", [result.error]); return; }
    lastStrategy = result;
    renderStrategy(result);
  }

  function renderStrategyMessage(headline, lines) {
    $("strat-headline").textContent = headline;
    $("strat-stats").innerHTML = "";
    $("ev-table").innerHTML = "";
    var a = $("strat-assumptions"); a.innerHTML = "";
    (lines || []).forEach(function (l) { var li = document.createElement("li"); li.textContent = l; a.appendChild(li); });
    $("strat-warnings").textContent = "";
  }

  function renderStrategy(r) {
    var pct = function (x) { return (x * 100).toFixed(1) + "%"; };
    var headline = r.action + (r.raiseTo ? " to " + r.raiseTo : r.amount ? " " + r.amount : "");
    $("strat-headline").textContent = headline;

    var stats = $("strat-stats"); stats.innerHTML = "";
    if (r.modeledEquity != null) addStat(stats, "Modelled equity", pct(r.modeledEquity));
    if (r.equityCi) addStat(stats, "95% CI", pct(r.equityCi[0]) + "–" + pct(r.equityCi[1]));
    if (r.potOdds) addStat(stats, "Break-even", pct(r.potOdds));
    // Realized-equity estimate (#1): heuristic, postflop only, shown beside raw
    // equity. The EV recommendation continues to use RAW showdown equity.
    var realizationNote = null;
    if (P.EquityRealization && r.modeledEquity != null) {
      var rctx = heroRealizationCtx();
      if (rctx && rctx.street !== "preflop") {
        var rz = P.EquityRealization.realizedEquity(r.modeledEquity, rctx);
        addStat(stats, "Realized eq. (est.)", pct(rz.realized) + " (×" + rz.R.toFixed(2) + ")");
        realizationNote = rz.assumptions[0];
      }
    }

    // EV table of the leading candidates. The last column shows the balanced
    // (GTO reference) bluff share of the betting range for BET candidates.
    var tbl = $("ev-table"); tbl.innerHTML = "";
    var head = document.createElement("tr");
    head.innerHTML = "<th>Action</th><th>Size</th><th>EV (chips)</th><th>Fold eq.</th><th title='Balanced bluff share of the betting range at this size (GTO reference)'>Bal. bluff</th>";
    tbl.appendChild(head);
    (r.evByAction || []).slice(0, 7).forEach(function (a) {
      var tr = document.createElement("tr");
      var size = a.raiseTo ? ("to " + a.raiseTo) : (a.amount ? a.amount : "—");
      var bluff = a.bluffTarget != null ? (a.bluffTarget * 100).toFixed(0) + "%" : "—";
      tr.innerHTML = "<td>" + a.action + "</td><td>" + size + "</td><td>" +
        (a.ev == null ? "—" : a.ev) + "</td><td>" + (a.foldEquity != null ? (a.foldEquity * 100).toFixed(0) + "%" : "—") + "</td><td>" + bluff + "</td>";
      tbl.appendChild(tr);
    });

    // GTO reference block (pot-geometry equilibrium; reference-only).
    var gto = $("gto-ref"); gto.innerHTML = "";
    if (r.equilibrium && r.equilibrium.facing) {
      var eq = r.equilibrium;
      gto.hidden = false;
      gto.innerHTML =
        '<div class="gto-title">GTO reference (size faced' +
        (eq.betFractionOfPot != null ? " ≈ " + (eq.betFractionOfPot * 100).toFixed(0) + "% pot" : "") + ")</div>" +
        '<div class="gto-row"><span>Min-defense freq</span><b>' + pct(eq.mdf) + "</b></div>" +
        '<div class="gto-row"><span>Bluff must fold (α)</span><b>' + pct(eq.alpha) + "</b></div>" +
        '<div class="gto-row"><span>Balanced value:bluff</span><b>' + (isFinite(eq.valueToBluff) ? eq.valueToBluff.toFixed(1) + ":1" : "—") + "</b></div>" +
        '<div class="gto-note">Reference only — the recommendation above is exploitative EV, not a solver output.</div>';
    } else if (r.equilibrium) {
      gto.hidden = false;
      gto.innerHTML = '<div class="gto-note">GTO reference: the “Bal. bluff” column shows the balanced bluff share for each candidate bet size. Reference only — advice is exploitative EV.</div>';
    } else {
      gto.hidden = true;
    }

    // Implied-odds reference for a drawing hand facing a bet.
    var io = r.impliedOdds;
    if (io) {
      var row = document.createElement("div");
      row.className = "gto-row io-row";
      var verdict = io.justifiedNow
        ? "pot odds already justify the call"
        : "need to win ≥ " + Math.round(io.wMin) + " more later";
      row.innerHTML = "<span>Draw: " + io.outs + " outs · next-card " + (io.oneCardHit * 100).toFixed(1) + "%</span><b>" + verdict + "</b>";
      gto.hidden = false;
      gto.appendChild(row);
      var n = document.createElement("div");
      n.className = "gto-note";
      n.textContent = io.note;
      gto.appendChild(n);
    }

    // Opponent-pool baseline (assumed priors for a zero-data opponent).
    var pb = r.populationBaseline;
    if (pb && pb.population && pb.population !== "default") {
      var prow = document.createElement("div");
      prow.className = "gto-row pop-row";
      prow.innerHTML = "<span>Pool baseline (" + pb.population + ")</span><b>VPIP " +
        (pb.vpip * 100).toFixed(0) + "% · PFR " + (pb.pfr * 100).toFixed(0) + "% · 3bet " + (pb.threeBet * 100).toFixed(0) + "%</b>";
      gto.hidden = false;
      gto.appendChild(prow);
    }

    var a = $("strat-assumptions"); a.innerHTML = "";
    (r.assumptions || []).forEach(function (s) { var li = document.createElement("li"); li.textContent = s; a.appendChild(li); });
    if (realizationNote) { var rli = document.createElement("li"); rli.textContent = realizationNote; a.appendChild(rli); }

    var warn = $("strat-warnings");
    warn.innerHTML = "";
    (r.warnings || []).forEach(function (w) { var d = document.createElement("div"); d.className = "warn"; d.textContent = "⚠ " + w; warn.appendChild(d); });
    if (r.opponentRanges && r.opponentRanges.length) {
      var src = document.createElement("div");
      src.className = "range-src";
      src.textContent = "Opponent ranges: " + r.opponentRanges.map(function (o) { return "seat " + (o.seatId + 1) + " — " + o.source + " (" + o.summary + ")"; }).join("; ");
      warn.appendChild(src);
    }
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
    $("rec-outlook").hidden = true;

    if (!hero.active) {
      setRec("neutral", "You have folded", "", ["Reactivate your seat (✓) to get advice."], null);
      setBanner("neutral", "FOLDED", "");
      return;
    }
    var res = state.lastResults && state.lastResults[state.heroIndex];
    if (!res) {
      setRec("neutral", "Add your cards", "", ["Click your seat's cards to enter your hand."], null);
      setBanner("neutral", "ADD CARDS", "");
      return;
    }
    if (knownCards(hero).length < 2) {
      setRec("neutral", (res.equity * 100).toFixed(1) + "% to win", "",
        ["Enter both of your hole cards for a betting recommendation.",
         "Current number is an average over all hands you could be holding."], res);
      setBanner("neutral", (res.equity * 100).toFixed(0) + "%", "enter both your cards");
      return;
    }

    // A bet is on the call button but its amount hasn't been taught yet - don't
    // pretend it's a free check; tell the player to teach the call amount.
    if (state.toCallPending && !(state.toCall > 0)) {
      setRec("neutral", "There's a bet to call", "",
        ["Watch can see a bet on your call button but hasn't learned its digits yet.",
         "Teach the call amount once (tap the digits it asks about) and it'll say CALL / RAISE / FOLD.",
         "Your chance to win right now is " + (res.equity * 100).toFixed(1) + "%."], res);
      setBanner("neutral", "BET TO CALL", "teach the call amount · " + (res.equity * 100).toFixed(0) + "% to win");
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
    var verb = adv.verb || (adv.action + (adv.amount ? " " + adv.amount : ""));
    var meta = (res.equity * 100).toFixed(0) + "% to win" + positionNote();
    setBanner(adv.tone, verb, meta);
    renderOutlook(knownCards(hero), board);
  }

  // Short position note from the dealer button, if we know it.
  function positionNote() {
    if (state.dealer == null) return "";
    var n = state.numPlayers, hero = state.heroIndex;
    var seatsAfterButton = (hero - state.dealer + n) % n; // 0 = button
    var label;
    if (seatsAfterButton === 0) label = "on the button";
    else if (seatsAfterButton === 1) label = "small blind";
    else if (seatsAfterButton === 2) label = "big blind";
    else if (seatsAfterButton >= n - 1) label = "cutoff";
    else if (seatsAfterButton <= Math.floor(n / 3) + 2) label = "early position";
    else label = "middle position";
    return " · " + label;
  }

  function setBanner(tone, verb, meta) {
    var banner = $("action-banner");
    if (!banner) return;
    banner.hidden = false;
    banner.className = "action-banner " + tone;
    $("action-verb").textContent = verb;
    $("action-meta").textContent = meta || "";
  }

  // Best and worst hands the hero can still finish with by the river, found by
  // enumerating every remaining board completion from the unseen deck.
  function computeBestWorst(heroCards, boardKnown) {
    var missing = 5 - boardKnown.length;
    if (missing <= 0) return null;                 // board already complete
    var pool = P.buildRemaining(state.decks, allUsedCards());
    if (P.nCk(pool.length, missing) > 200000) return null; // too many runouts (pre-flop)

    var bestScore = -1, worstScore = Infinity, bestDraw = null, worstDraw = null;
    var draw = new Array(missing);
    var seven = [heroCards[0], heroCards[1], 0, 0, 0, 0, 0];
    (function rec(start, depth) {
      if (depth === missing) {
        for (var b = 0; b < boardKnown.length; b++) seven[2 + b] = boardKnown[b];
        for (var d = 0; d < missing; d++) seven[2 + boardKnown.length + d] = draw[d];
        var s = P.evaluate7(seven);
        if (s > bestScore) { bestScore = s; bestDraw = draw.slice(); }
        if (s < worstScore) { worstScore = s; worstDraw = draw.slice(); }
        return;
      }
      for (var i = start; i <= pool.length - (missing - depth); i++) {
        draw[depth] = pool[i]; rec(i + 1, depth + 1);
      }
    })(0, 0);
    return { best: { score: bestScore, cards: bestDraw }, worst: { score: worstScore, cards: worstDraw } };
  }

  function renderOutlook(heroCards, board) {
    var el = $("rec-outlook");
    if (heroCards.length < 2 || board.length < 3 || board.length >= 5) { el.hidden = true; return; }
    var bw = computeBestWorst(heroCards, board);
    if (!bw) { el.hidden = true; return; }
    var need = 5 - board.length;
    el.innerHTML = "";
    el.appendChild(outlookRow("good", "Best case", P.handName(bw.best.score), bw.best.cards, need));
    el.appendChild(outlookRow("bad", "Worst case", P.handName(bw.worst.score), bw.worst.cards, need));
    el.hidden = false;
  }

  function outlookRow(tone, label, handText, cards, need) {
    var row = document.createElement("div");
    row.className = "outlook-row " + tone;
    var lbl = document.createElement("span");
    lbl.className = "ol-lbl"; lbl.textContent = label;
    var val = document.createElement("span");
    val.className = "ol-val"; val.textContent = handText;
    var needEl = document.createElement("span");
    needEl.className = "ol-need";
    needEl.textContent = (need === 1 ? "if " : "e.g. ") + cards.map(P.cardLabel).join(" ");
    row.appendChild(lbl); row.appendChild(val); row.appendChild(needEl);
    return row;
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
  // Sync the "reshuffle every hand" checkbox with the shoe-length slider. When
  // on, the shoe is one hand long (Next hand = a full fresh deck) and the slider
  // is disabled; when off, the slider drives a multi-hand shoe (min 2 hands).
  function applyReshuffleMode(userToggled) {
    var slider = $("in-shuffle"), field = $("shuffle-field");
    if (state.reshuffleEveryHand) {
      state.handsBeforeShuffle = 1;
      slider.value = 1; $("shuffle-val").textContent = 1;
      slider.disabled = true; if (field) field.classList.add("is-disabled");
      if (userToggled) shuffle();            // return to one full, shuffled deck now
      else updateShoeHint();
    } else {
      slider.disabled = false; if (field) field.classList.remove("is-disabled");
      if (parseInt(slider.value, 10) < 2) slider.value = 2; // "off" means >1 hand
      state.handsBeforeShuffle = parseInt(slider.value, 10);
      $("shuffle-val").textContent = state.handsBeforeShuffle;
      updateShoeHint();
    }
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
    $("in-reshuffle").addEventListener("change", function () {
      state.reshuffleEveryHand = this.checked;
      applyReshuffleMode(true);
    });
    $("in-shuffle").addEventListener("input", function () {
      state.handsBeforeShuffle = parseInt(this.value, 10);
      $("shuffle-val").textContent = state.handsBeforeShuffle;
      updateShoeHint();
    });
    $("in-quality").addEventListener("change", function () {
      state.trials = parseInt(this.value, 10); scheduleCompute();
    });

    // Advanced range-EV controls.
    $("in-advanced").addEventListener("change", function () {
      state.advanced = this.checked;
      $("advanced-body").hidden = !this.checked;
      scheduleAdvanced();
    });
    $("in-sb").addEventListener("input", function () { state.smallBlind = Math.max(0, parseInt(this.value || "0", 10)); scheduleAdvanced(); });
    $("in-bb").addEventListener("input", function () { state.bigBlind = Math.max(0, parseInt(this.value || "0", 10)); scheduleAdvanced(); });
    $("in-ante").addEventListener("input", function () { state.ante = Math.max(0, parseInt(this.value || "0", 10)); scheduleAdvanced(); });
    $("in-potmode").addEventListener("change", function () { state.potDisplayMode = this.value; scheduleAdvanced(); });
    $("in-gamemode").addEventListener("change", function () {
      state.gameMode = this.value;
      $("rake-fields").hidden = this.value !== "cash";
      // Sync rake state from the visible field defaults when entering cash mode,
      // so the shown % actually applies without needing to re-type it.
      if (this.value === "cash") {
        state.rakePercent = Math.max(0, (parseFloat($("in-rakepct").value || "0") || 0) / 100);
        state.rakeCap = Math.max(0, parseInt($("in-rakecap").value || "0", 10) || 0);
      }
      scheduleAdvanced();
    });
    $("in-rakepct").addEventListener("input", function () { state.rakePercent = Math.max(0, (parseFloat(this.value || "0") || 0) / 100); scheduleAdvanced(); });
    $("in-rakecap").addEventListener("input", function () { state.rakeCap = Math.max(0, parseInt(this.value || "0", 10) || 0); scheduleAdvanced(); });
    $("in-population").addEventListener("change", function () { state.population = this.value; scheduleAdvanced(); });
    $("in-hero-range").addEventListener("change", function () {
      state.heroRangeSource = this.value;
      $("hero-range-field").hidden = this.value !== "manual";
      if (this.value === "none") $("rvr-card").hidden = true;
      scheduleAdvanced();
    });
    $("in-hero-range-text").addEventListener("input", function () { state.heroRangeText = this.value; scheduleAdvanced(); });
    $("in-range-source").addEventListener("change", function () {
      state.rangeSource = this.value;
      $("manual-range-field").hidden = this.value !== "manual";
      scheduleAdvanced();
    });
    $("in-range-text").addEventListener("input", function () {
      state.manualRange = this.value;
      var parsed = P.Ranges.parse(this.value || "");
      $("range-summary").textContent = parsed.ok
        ? (parsed.range.length ? P.Ranges.summary(parsed.range) : "empty range")
        : "Invalid: " + parsed.error;
      scheduleAdvanced();
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

  // ---------- Public API (used by Watch mode / external feeders) ----------
  // A "reading" may set any of: hero cards, board cards, player active flags.
  // Values: a card id sets it, null clears it, undefined leaves it untouched
  // (so an uncertain region never clobbers a manual entry).
  function applyReading(reading) {
    var changed = false, i;
    if (reading.hero) {
      var hero = state.players[state.heroIndex];
      for (i = 0; i < 2; i++) {
        var hv = reading.hero[i];
        if (hv !== undefined && hero.cards[i] !== hv) { hero.cards[i] = hv; changed = true; }
      }
    }
    if (reading.board) {
      for (i = 0; i < 5; i++) {
        var bv = reading.board[i];
        if (bv !== undefined && state.board[i] !== bv) { state.board[i] = bv; changed = true; }
      }
    }
    // Player count first, so any active-flag changes below land on the right seats.
    if (typeof reading.numPlayers === "number") {
      var n = Math.max(2, Math.min(10, reading.numPlayers | 0));
      if (n !== state.numPlayers) {
        state.numPlayers = n; $("in-players").value = n; $("players-val").textContent = n;
        ensurePlayers();
        changed = true;
      }
    }
    if (reading.actives) {
      reading.actives.forEach(function (a) {
        var pl = state.players[a.index];
        if (pl && pl.active !== a.active) { pl.active = a.active; changed = true; }
      });
    }
    // Fixed-seat reading API: seats keep their identity; folding only flips the
    // active flag, it never removes or renumbers a seat. Accepts the richer
    // canonical shape { seatId, occupied, dealtIn, active, folded, allIn,
    // stackBehind, streetCommitted, confidence }.
    if (reading.seats && reading.seats.length) {
      var maxSeat = 0;
      reading.seats.forEach(function (s) { if (s.occupied !== false) maxSeat = Math.max(maxSeat, s.seatId); });
      var wantN = Math.max(2, Math.min(10, maxSeat + 1));
      if (wantN !== state.numPlayers) {
        state.numPlayers = wantN; $("in-players").value = wantN; $("players-val").textContent = wantN;
        ensurePlayers(); changed = true;
      }
      reading.seats.forEach(function (s) {
        var pl = state.players[s.seatId];
        if (!pl) return;
        var active = s.active != null ? s.active : !s.folded;
        if (pl.active !== active) { pl.active = active; changed = true; }
        if (typeof s.stackBehind === "number" && pl.stack !== s.stackBehind) { pl.stack = s.stackBehind; changed = true; }
        if (typeof s.streetCommitted === "number" && pl.bet !== s.streetCommitted) { pl.bet = s.streetCommitted; changed = true; }
      });
    }
    if (typeof reading.buttonSeat === "number" && state.dealer !== reading.buttonSeat) {
      state.dealer = reading.buttonSeat; changed = true;
    }
    if (typeof reading.potDisplayMode === "string") { state.potDisplayMode = reading.potDisplayMode; }
    // Opponents' bets from Watch, mapped to the non-hero seats in order. undefined
    // = that bet box isn't set (leave it); null = boxed but no bet -> 0.
    if (reading.bets) {
      var oi = 0;
      for (var pi = 0; pi < state.players.length; pi++) {
        if (pi === state.heroIndex) continue;
        var bv = reading.bets[oi]; oi++;
        if (bv === undefined) continue;
        var nb = bv == null ? 0 : bv;
        if (state.players[pi].bet !== nb) { state.players[pi].bet = nb; changed = true; }
      }
    }
    if (typeof reading.pot === "number" && reading.pot >= 0 && state.pot !== reading.pot) {
      state.pot = reading.pot; $("in-pot").value = reading.pot; changed = true;
    }
    if (typeof reading.toCall === "number" && reading.toCall >= 0 && state.toCall !== reading.toCall) {
      state.toCall = reading.toCall; $("in-call").value = reading.toCall; changed = true;
    }
    // A bet is on the call button but its amount isn't readable yet (teach the
    // digits): don't let it look like a free check.
    if (typeof reading.toCall === "number") { if (state.toCallPending) { state.toCallPending = false; changed = true; } }
    else if (reading.toCallPending && !state.toCallPending) { state.toCallPending = true; changed = true; }
    if (typeof reading.stack === "number" && reading.stack >= 0) {
      var hp = state.players[state.heroIndex];
      if (hp.stack !== reading.stack) { hp.stack = reading.stack; syncStackInput(); changed = true; }
    }
    if (typeof reading.dealer === "number" && state.dealer !== reading.dealer) {
      state.dealer = reading.dealer; changed = true;
    }
    if (changed) { render(); scheduleCompute(); }
    return changed;
  }

  window.PokerAssistant = {
    applyReading: applyReading,
    makeId: function (rank, suit) { return P.makeId(rank, suit); },
    cardLabel: function (id) { return P.cardLabel(id); },
    getInfo: function () { return { heroIndex: state.heroIndex, numPlayers: state.numPlayers }; },
    setPlayerCount: function (n) {
      n = Math.max(2, Math.min(10, n | 0));
      if (n === state.numPlayers) return;
      state.numPlayers = n;
      $("in-players").value = n; $("players-val").textContent = n;
      render(); scheduleCompute();
    },
  };

  // ---------- Init ----------
  function init() {
    ensurePlayers();
    bindInputs();
    syncStackInput();
    $("in-reshuffle").checked = state.reshuffleEveryHand;
    applyReshuffleMode(false);
    render();
    scheduleCompute();
  }
  init();
})();
