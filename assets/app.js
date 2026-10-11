/*
 * Desk Reject: Reviewer 2 soundboard.
 * Plain browser JavaScript, no build step. Works from file://, a static host
 * (GitHub Pages), as an installed web app or inside the Electron shell.
 *
 * Storage (all local to the browser):
 *   localStorage "desk-reject:v1"   board + settings (JSON)
 *   IndexedDB    "desk-reject"      recordings, keyed by comment id
 *
 * Board model (version 2):
 *   comments  every comment, wherever it is
 *   banks     { A: [16 slots], B: [...], C: [...], D: [...] }, each slot a comment id or null
 *   A comment that sits in no slot is in the reserve: it has no pad, but the
 *   Reviewer 2 stamp can still draw it.
 */
(function () {
  "use strict";

  var STORE_KEY = "desk-reject:v1";
  var PRESETS = window.DESK_REJECT_PRESETS || [];
  var SEVERITIES = ["comment", "revise", "reject"];
  var MAX_REC_MS = 8000;
  var BANKS = ["A", "B", "C", "D"];
  var PADS = 16;
  // Pads are laid out 4 x 4, like a drum machine: keys follow the physical grid
  // (e.code), so they stay in place on any keyboard layout.
  var PAD_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyQ", "KeyW", "KeyE", "KeyR",
                   "KeyA", "KeyS", "KeyD", "KeyF", "KeyZ", "KeyX", "KeyC", "KeyV"];
  var PAD_LABELS = "1234QWERASDFZXCV".split("");
  var LONG_PRESS_MS = 550;

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------ state

  function uid() {
    return "c" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }

  function emptyBanks() {
    var b = {};
    BANKS.forEach(function (n) { b[n] = new Array(PADS).fill(null); });
    return b;
  }

  function defaultSettings() {
    return { voiceURI: null, rate: 1, pitch: 1, randomFrom: "all", allVoices: false, bank: "A" };
  }

  // Fill banks in order with the ids of comments flagged board: true (older
  // boards and the presets use that flag); anything beyond 64 goes to the reserve.
  function banksFromFlags(comments, flags) {
    var banks = emptyBanks();
    var n = 0;
    comments.forEach(function (c, i) {
      if (!flags[i] || n >= BANKS.length * PADS) return;
      banks[BANKS[Math.floor(n / PADS)]][n % PADS] = c.id;
      n += 1;
    });
    return banks;
  }

  function fromPreset(preset) {
    var comments = preset.comments.map(function (c) {
      return { id: uid(), text: c.text, severity: c.severity || "comment", random: c.random !== false };
    });
    return {
      version: 2,
      name: preset.name,
      lang: preset.lang || "en",
      comments: comments,
      banks: banksFromFlags(comments, preset.comments.map(function (c) { return c.board !== false; })),
      settings: defaultSettings()
    };
  }

  function sanitizeBoard(raw) {
    if (!raw || !Array.isArray(raw.comments)) return null;
    var seen = new Set();
    var kept = raw.comments.filter(function (c) { return c && typeof c.text === "string" && c.text.trim(); });
    var comments = kept.map(function (c) {
      var id = typeof c.id === "string" && /^[\w-]{1,40}$/.test(c.id) && !seen.has(c.id) ? c.id : uid();
      seen.add(id);
      return {
        id: id,
        text: c.text.trim().slice(0, 140),
        severity: SEVERITIES.indexOf(c.severity) >= 0 ? c.severity : "comment",
        random: c.random !== false
      };
    });

    var banks;
    if (raw.banks && typeof raw.banks === "object") {
      banks = emptyBanks();
      var placed = new Set();
      BANKS.forEach(function (n) {
        var src = Array.isArray(raw.banks[n]) ? raw.banks[n] : [];
        for (var i = 0; i < PADS; i++) {
          var id = src[i];
          if (typeof id === "string" && seen.has(id) && !placed.has(id)) { banks[n][i] = id; placed.add(id); }
        }
      });
    } else {
      // version 1 board: a list with board: true/false
      banks = banksFromFlags(comments, kept.map(function (c) { return c.board !== false; }));
    }

    var s = raw.settings || {};
    return {
      version: 2,
      name: typeof raw.name === "string" ? raw.name.slice(0, 60) : "Custom board",
      lang: typeof raw.lang === "string" ? raw.lang.slice(0, 12) : "en",
      comments: comments,
      banks: banks,
      settings: {
        voiceURI: typeof s.voiceURI === "string" ? s.voiceURI : null,
        rate: clamp(Number(s.rate) || 1, 0.6, 1.6),
        pitch: clamp(Number(s.pitch) || 1, 0.5, 1.5),
        randomFrom: s.randomFrom === "board" ? "board" : "all",
        allVoices: !!s.allVoices,
        bank: BANKS.indexOf(s.bank) >= 0 ? s.bank : "A"
      }
    };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY));
      var b = sanitizeBoard(raw);
      if (b) return b;
    } catch (e) { /* private mode or corrupt: fall through */ }
    return fromPreset(PRESETS[0]);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  var state = load();
  var recIds = new Set();
  var editing = false;
  var lastRandomId = null;

  // ------------------------------------------------------------ bank helpers

  function byId(id) { return state.comments.find(function (c) { return c.id === id; }) || null; }
  function bank() { return state.settings.bank; }

  function slotOf(id) {
    for (var b = 0; b < BANKS.length; b++) {
      var i = state.banks[BANKS[b]].indexOf(id);
      if (i >= 0) return { bank: BANKS[b], slot: i };
    }
    return null;
  }

  function padsOf(name) { return state.banks[name].map(function (id) { return id ? byId(id) : null; }); }
  function firstFree(name) { return state.banks[name].indexOf(null); }
  function unplace(id) { BANKS.forEach(function (n) { var i = state.banks[n].indexOf(id); if (i >= 0) state.banks[n][i] = null; }); }
  function bankUsed(name) { return state.banks[name].some(Boolean); }

  // ------------------------------------------------------------- recordings

  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open("desk-reject", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("recordings"); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction("recordings", mode);
        var store = tx.objectStore("recordings");
        var req = fn(store);
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  var recGet = function (id) { return idb("readonly", function (s) { return s.get(id); }); };
  var recPut = function (id, blob) { return idb("readwrite", function (s) { return s.put(blob, id); }); };
  var recDel = function (id) { return idb("readwrite", function (s) { return s.delete(id); }); };
  var recKeys = function () { return idb("readonly", function (s) { return s.getAllKeys(); }); };
  var recClear = function () { return idb("readwrite", function (s) { return s.clear(); }); };

  // ---------------------------------------------------------------- speech

  var synth = window.speechSynthesis || null;
  var voices = [];
  var currentAudio = null;
  var currentUtterance = null; // held so Chrome does not garbage-collect it before onend
  var playingBtn = null;

  function loadVoices() {
    if (!synth) return;
    // Safari lists some voices twice under the same name (for example the
    // compact and the enhanced Daniel): keep one per name and language,
    // the better one.
    var best = {};
    synth.getVoices().forEach(function (v) {
      var key = v.name + "|" + v.lang;
      var cur = best[key];
      if (!cur || voiceQuality(v) > voiceQuality(cur) || (voiceQuality(v) === voiceQuality(cur) && v.localService && !cur.localService)) best[key] = v;
    });
    voices = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) {
      return a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
    renderVoiceSelect();
  }

  function langVoices() {
    var prefix = (state.lang || "en").toLowerCase().split("-")[0];
    return voices.filter(function (v) { return v.lang.toLowerCase().indexOf(prefix) === 0; });
  }

  // macOS ships a set of novelty voices (bells, organ, whisper…) and the older
  // Eloquence voices ("Eddy (English (United Kingdom))"…): keep them apart.
  var NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
  // Quality from the name ("Serena (Premium)") or, in Safari, from the
  // identifier ("com.apple.voice.enhanced.en-GB.Daniel").
  function voiceQuality(v) {
    var s = v.name + " " + (v.voiceURI || "");
    return /premium/i.test(s) ? 2 : /enhanced/i.test(s) ? 1 : 0;
  }
  function voiceName(v) {
    var q = voiceQuality(v);
    if (q && !/premium|enhanced/i.test(v.name)) return v.name + (q === 2 ? " (Premium)" : " (Enhanced)");
    return v.name;
  }
  function voiceGroup(v) {
    if (NOVELTY.test(v.name)) return "novelty";
    if (/\(English \(/.test(v.name)) return "other";
    if (voiceQuality(v) > 0 || /GB/i.test(v.lang)) return "recommended";
    return "other";
  }
  function voiceRank(v) { return -voiceQuality(v) * 10 + (/GB/i.test(v.lang) ? 0 : 1); }

  function pickVoice() {
    if (!voices.length) return null;
    var chosen = voices.find(function (v) { return v.voiceURI === state.settings.voiceURI; });
    if (chosen) return chosen;
    var pool = langVoices();
    if (!pool.length) return null;
    // Prefer a British voice for Reviewer 2 (Premium, then Enhanced, then
    // Daniel), then any local voice; never a novelty one.
    pool = pool.filter(function (v) { return voiceGroup(v) !== "novelty"; });
    if (!pool.length) return null;
    var gb = pool.filter(function (v) { return /GB/i.test(v.lang) && voiceGroup(v) === "recommended"; });
    var best = gb.slice().sort(function (a, b) { return voiceQuality(b) - voiceQuality(a); })[0];
    if (best && voiceQuality(best) > 0) return best;
    var ordered = gb.concat(pool);
    return ordered.find(function (v) { return /Daniel/i.test(v.name); }) ||
           ordered.find(function (v) { return v.localService; }) ||
           ordered[0];
  }

  function stopAll() {
    currentUtterance = null;
    if (synth) synth.cancel();
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.src);
      currentAudio = null;
    }
    if (playingBtn) { playingBtn.classList.remove("playing"); playingBtn = null; }
  }

  function speak(text, onEnd) {
    if (!synth) { toast("This browser cannot read text aloud. Record the comment instead."); onEnd(); return; }
    var u = new SpeechSynthesisUtterance(text);
    var v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = state.lang; }
    u.rate = state.settings.rate;
    u.pitch = state.settings.pitch;
    var finished = false;
    var finish = function () {
      if (finished) return;
      finished = true;
      if (currentUtterance === u) currentUtterance = null;
      onEnd();
    };
    u.onend = finish;
    u.onerror = finish;
    currentUtterance = u;
    synth.speak(u);
  }

  function play(comment, btn) {
    stopAll();
    showVerdict(comment);
    if (btn) { playingBtn = btn; btn.classList.add("playing"); }
    var done = function () { if (btn) btn.classList.remove("playing"); if (playingBtn === btn) playingBtn = null; };

    if (recIds.has(comment.id)) {
      recGet(comment.id).then(function (blob) {
        if (!blob) { speak(comment.text, done); return; }
        var a = new Audio(URL.createObjectURL(blob));
        currentAudio = a;
        a.onended = function () { URL.revokeObjectURL(a.src); if (currentAudio === a) currentAudio = null; done(); };
        a.play().catch(function () { speak(comment.text, done); });
      }).catch(function () { speak(comment.text, done); });
    } else {
      speak(comment.text, done);
    }
  }

  function padButton(id) { return document.querySelector('#board .comment-btn[data-id="' + id + '"]'); }

  function playRandom() {
    var pool = state.comments.filter(function (c) {
      return c.random && (state.settings.randomFrom === "all" || slotOf(c.id));
    });
    if (!pool.length) { toast("Reviewer 2 has nothing to draw. Open a comment and tick “Reviewer 2 can draw this comment”."); return; }
    var candidates = pool.length > 1 ? pool.filter(function (c) { return c.id !== lastRandomId; }) : pool;
    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    lastRandomId = pick.id;
    var stamp = $("random-btn");
    stamp.classList.remove("slam");
    void stamp.offsetWidth; // restart the animation
    stamp.classList.add("slam");
    play(pick, padButton(pick.id)); // a drawn comment on the visible bank lights its pad
  }

  // ------------------------------------------------------------- rendering

  var round = 1;

  function showVerdict(c) {
    var q = $("verdict-quote");
    q.textContent = "“" + c.text + "”";
    q.dataset.sev = c.severity;
    q.classList.remove("typeset");
    void q.offsetWidth;
    q.classList.add("typeset");
    $("verdict-label").textContent = "Reviewer 2 writes:";
    round += 1;
    $("ms-round").textContent = String(round);
  }

  function attachPadGestures(btn, onTap, onHold) {
    // Long press (touch) or right click opens the editor, so any pad can be
    // rewritten or recorded without entering edit mode.
    var pressTimer = null, longPressed = false;
    btn.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      longPressed = false;
      pressTimer = setTimeout(function () { longPressed = true; onHold(); }, LONG_PRESS_MS);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearTimeout(pressTimer); });
    });
    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); clearTimeout(pressTimer); if (!longPressed) onHold(); });
    btn.addEventListener("click", function () {
      if (longPressed) { longPressed = false; return; }
      onTap();
    });
  }

  function commentItem(c, slot) {
    var onPad = slot !== null;
    var li = document.createElement("li");
    li.className = "comment sev-" + c.severity;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comment-btn";
    btn.dataset.id = c.id;

    var num = document.createElement("span");
    num.className = "num";
    if (onPad) {
      var k = document.createElement("kbd");
      k.textContent = PAD_LABELS[slot];
      k.title = "Keyboard shortcut";
      num.appendChild(k);
    }
    var txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = c.text;
    var mark = document.createElement("span");
    mark.className = "rec-mark";
    var marks = [];
    if (recIds.has(c.id)) marks.push(onPad ? "● rec" : "recorded");
    if (!c.random) marks.push("not drawn");
    if (!onPad) { var where = slotOf(c.id); if (where) marks.push("bank " + where.bank); }
    mark.textContent = marks.join(", ");

    btn.append(num, txt, mark);
    attachPadGestures(btn, function () { play(c, btn); }, function () { openEditor(c.id); });
    btn.setAttribute("aria-label", c.text + " (" + c.severity + (recIds.has(c.id) ? ", recorded voice" : "") + ")");
    makeDraggable(btn, c.id);
    if (onPad) makeDropTarget(li, function (id) { dropOnSlot(id, slot); });

    var tools = document.createElement("div");
    tools.className = "comment-tools";
    if (onPad) {
      // Compact symbols on the pad itself; the full wording is in the tooltip.
      tools.append(
        tool("✎", "Edit “" + c.text + "”", function () { openEditor(c.id); }, "Edit"),
        tool("←", "Move “" + c.text + "” one pad back", function () { move(c.id, -1); }, "Move one pad back"),
        tool("→", "Move “" + c.text + "” one pad forward", function () { move(c.id, 1); }, "Move one pad forward"),
        tool("✕", "Remove “" + c.text + "” from its pad (it stays in the reserve)", function () { unplace(c.id); commit(); toast("Moved to the reserve."); }, "Remove from pad")
      );
    } else {
      tools.append(
        tool("Edit", "Edit “" + c.text + "”", function () { openEditor(c.id); }),
        tool("Add to pad", "Add “" + c.text + "” to the first free pad of bank " + bank(), function () { putOnPad(c.id); })
      );
    }

    li.append(btn, tools);
    return li;
  }

  function emptyItem(slot) {
    var li = document.createElement("li");
    li.className = "comment pad-empty";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comment-btn";
    btn.dataset.slot = String(slot);
    var num = document.createElement("span");
    num.className = "num";
    var k = document.createElement("kbd");
    k.textContent = PAD_LABELS[slot];
    num.appendChild(k);
    var plus = document.createElement("span");
    plus.className = "plus";
    plus.setAttribute("aria-hidden", "true");
    plus.textContent = "+";
    btn.append(num, plus);
    btn.setAttribute("aria-label", "Add a comment on pad " + PAD_LABELS[slot] + " of bank " + bank());
    btn.addEventListener("click", function () { openPicker(slot); });
    li.appendChild(btn);
    makeDropTarget(li, function (id) { dropOnSlot(id, slot); });
    return li;
  }

  // ---------------------------------------------------------- drag and drop
  // Edit mode only, so nothing moves by accident while playing: a comment can be
  // dragged onto any pad (swapping with what is there, or into an empty one),
  // onto a bank button (first free pad of that bank) or onto the reserve.

  var dragId = null;
  var libWired = false;

  function makeDraggable(btn, id) {
    if (!editing) return;
    btn.draggable = true;
    btn.addEventListener("dragstart", function (e) {
      dragId = id;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", id); } catch (err) { /* ignore */ }
      btn.classList.add("dragging");
    });
    btn.addEventListener("dragend", function () {
      dragId = null;
      btn.classList.remove("dragging");
      document.querySelectorAll(".drop-target").forEach(function (el) { el.classList.remove("drop-target"); });
    });
  }

  function makeDropTarget(el, onDrop) {
    if (!editing) return;
    el.addEventListener("dragover", function (e) {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", function (e) {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
    });
    el.addEventListener("drop", function (e) {
      if (!dragId) return;
      e.preventDefault();
      el.classList.remove("drop-target");
      var id = dragId;
      dragId = null;
      onDrop(id);
    });
  }

  function dropOnSlot(id, slot) {
    var slots = state.banks[bank()];
    var from = slotOf(id);
    if (from && from.bank === bank() && from.slot === slot) return;
    var other = slots[slot];
    unplace(id);
    if (other && from) state.banks[from.bank][from.slot] = other; // swap
    // (dragged from the reserve: the comment that was on the pad goes to the reserve)
    slots[slot] = id;
    commit();
  }

  function dropOnBank(id, name) {
    var from = slotOf(id);
    if (from && from.bank === name) return;
    var i = firstFree(name);
    if (i < 0) { toast("Bank " + name + " is full."); return; }
    unplace(id);
    state.banks[name][i] = id;
    commit();
    toast("Moved to pad " + PAD_LABELS[i] + " of bank " + name + ".");
  }

  function tool(label, aria, fn, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "text-btn";
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    if (title) b.title = title;
    b.dataset.tool = label;
    b.addEventListener("click", fn);
    return b;
  }

  function renderBanks() {
    var bar = $("bank-bar");
    bar.replaceChildren();
    BANKS.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "bank-btn";
      b.textContent = n;
      b.setAttribute("aria-pressed", String(n === bank()));
      b.setAttribute("aria-label", "Bank " + n + (bankUsed(n) ? "" : ", empty"));
      if (bankUsed(n)) b.classList.add("used");
      b.addEventListener("click", function () { selectBank(n); });
      makeDropTarget(b, function (id) { dropOnBank(id, n); });
      bar.appendChild(b);
    });
  }

  function render() {
    var board = $("board"), lib = $("library");
    board.replaceChildren();
    lib.replaceChildren();
    padsOf(bank()).forEach(function (c, i) { board.appendChild(c ? commentItem(c, i) : emptyItem(i)); });
    var placed = new Set();
    BANKS.forEach(function (n) { state.banks[n].forEach(function (id) { if (id) placed.add(id); }); });
    var reserve = state.comments.filter(function (c) { return !placed.has(c.id); });
    reserve.forEach(function (c) { lib.appendChild(commentItem(c, null)); });
    if (editing && !libWired) {
      // The reserve list itself accepts drops: the comment leaves its pad.
      libWired = true;
      lib.addEventListener("dragover", function (e) { if (dragId && slotOf(dragId)) { e.preventDefault(); lib.classList.add("drop-target"); } });
      lib.addEventListener("dragleave", function (e) { if (!lib.contains(e.relatedTarget)) lib.classList.remove("drop-target"); });
      lib.addEventListener("drop", function (e) {
        if (!dragId) return;
        e.preventDefault();
        lib.classList.remove("drop-target");
        var id = dragId; dragId = null;
        if (slotOf(id)) { unplace(id); commit(); toast("Moved to the reserve."); }
      });
    }
    if (editing && !reserve.length) {
      var li2 = document.createElement("li");
      li2.className = "note";
      li2.textContent = "Every comment is on a pad.";
      lib.appendChild(li2);
    }
    renderBanks();
    $("bank-label").textContent = "Bank " + bank();
    document.body.classList.toggle("editing", editing);
    fitPads(); // after the editing class, which changes the room inside the pads
    $("edit-toggle").setAttribute("aria-pressed", String(editing));
    $("edit-toggle").textContent = editing ? "Done" : "Edit pads";
  }

  function commit() { save(); render(); }

  // Pads keep their size: a long comment gets a smaller font instead.
  function fitPads() {
    var btns = document.querySelectorAll("#board .comment-btn");
    btns.forEach(function (btn) {
      var txt = btn.querySelector(".txt");
      if (!txt) return;
      txt.style.fontSize = "";
      var size = parseFloat(getComputedStyle(txt).fontSize) || 16;
      var cs = getComputedStyle(btn);
      var room = btn.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      var width = btn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (room <= 0 || width <= 0) return;
      while (size > 7.5 && (txt.scrollHeight > room || txt.scrollWidth > width)) {
        size -= 0.5;
        txt.style.fontSize = size + "px";
      }
    });
  }
  var fitTimer = null;
  window.addEventListener("resize", function () { clearTimeout(fitTimer); fitTimer = setTimeout(fitPads, 60); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitPads(); });

  // --------------------------------------------------------------- picker
  // The + on an empty pad: write a new comment, or bring an existing one here
  // (from the reserve or from another pad, which is then left empty).

  var pickSlot = null;

  function whereLabel(id) {
    var w = slotOf(id);
    return w ? "Bank " + w.bank + " · " + PAD_LABELS[w.slot] : "Reserve";
  }

  function renderPickList() {
    var list = $("pick-list");
    var q = $("pick-search").value.trim().toLowerCase();
    list.replaceChildren();
    // reserve first, then comments sitting on other pads
    var items = state.comments.slice().sort(function (a, b) { return (slotOf(a.id) ? 1 : 0) - (slotOf(b.id) ? 1 : 0); });
    var shown = 0;
    items.forEach(function (c) {
      if (q && c.text.toLowerCase().indexOf(q) < 0) return;
      var li = document.createElement("li");
      li.className = "sev-" + c.severity;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pick-item";
      var t = document.createElement("span");
      t.className = "pick-text";
      t.textContent = c.text;
      var w = document.createElement("span");
      w.className = "pick-where";
      w.textContent = whereLabel(c.id);
      b.append(t, w);
      b.addEventListener("click", function () {
        var slot = pickSlot;
        $("pick-dialog").close("picked");
        dropOnSlot(c.id, slot);
        toast("“" + c.text + "” is now on pad " + PAD_LABELS[slot] + " of bank " + bank() + ".");
      });
      li.appendChild(b);
      list.appendChild(li);
      shown += 1;
    });
    if (!shown) {
      var none = document.createElement("li");
      none.className = "note";
      none.textContent = "No comment matches.";
      list.appendChild(none);
    }
  }

  function openPicker(slot) {
    pickSlot = slot;
    $("pick-title").textContent = "Pad " + PAD_LABELS[slot] + ", bank " + bank();
    $("pick-search").value = "";
    showPickList(false);
    $("pick-dialog").showModal();
  }

  function showPickList(on) {
    $("pick-existing-box").hidden = !on;
    $("pick-existing").setAttribute("aria-expanded", String(on));
    $("pick-existing").classList.toggle("active", on);
    if (on) { renderPickList(); $("pick-search").focus(); }
  }

  function wirePicker() {
    $("pick-search").addEventListener("input", renderPickList);
    $("pick-new").addEventListener("click", function () {
      var slot = pickSlot;
      $("pick-dialog").close("new");
      openEditor(null, { bank: bank(), slot: slot });
    });
    $("pick-record").addEventListener("click", function () {
      var slot = pickSlot;
      $("pick-dialog").close("record");
      openEditor(null, { bank: bank(), slot: slot }, true);
    });
    $("pick-existing").addEventListener("click", function () { showPickList($("pick-existing-box").hidden); });
  }

  function selectBank(n) {
    if (BANKS.indexOf(n) < 0 || n === bank()) return;
    state.settings.bank = n;
    commit();
  }

  function putOnPad(id) {
    var i = firstFree(bank());
    if (i < 0) { toast("Bank " + bank() + " is full. Take a comment off a pad, or switch bank."); return; }
    unplace(id);
    state.banks[bank()][i] = id;
    commit();
    toast("Now on pad " + PAD_LABELS[i] + " of bank " + bank() + ".");
  }

  function move(id, delta) {
    // Swap with the neighbouring slot of the same bank, empty or not.
    var slots = state.banks[bank()];
    var pos = slots.indexOf(id);
    var target = pos + delta;
    if (pos < 0 || target < 0 || target >= PADS) return;
    slots[pos] = slots[target];
    slots[target] = id;
    commit();
    var again = padButton(id);
    if (again) {
      var t = again.parentNode.querySelector('.comment-tools [data-tool="' + (delta < 0 ? "←" : "→") + '"]');
      (t || again).focus();
    }
  }

  // ---------------------------------------------------------------- editor

  var editingId = null;
  var draft = null;     // { id, bank, slot } while a new comment is being written
  var recorder = null;
  var recTimer = null;

  function openEditor(id, newSlot, recordFirst) {
    if (id) {
      var c = byId(id);
      if (!c) return;
      draft = null;
      editingId = id;
      $("edit-text").value = c.text;
      $("edit-severity").value = c.severity;
      $("edit-random").checked = c.random;
      $("edit-title").textContent = "Edit comment";
      $("edit-delete").hidden = false;
    } else {
      draft = { id: uid(), bank: newSlot.bank, slot: newSlot.slot };
      editingId = draft.id;
      $("edit-text").value = "";
      $("edit-severity").value = "comment";
      $("edit-random").checked = true;
      $("edit-title").textContent = (recordFirst ? "Record a new comment" : "New comment") + ", pad " + PAD_LABELS[newSlot.slot] + " of bank " + newSlot.bank;
      $("edit-delete").hidden = true;
    }
    $("edit-text-label").textContent = recordFirst ? "What it says (shown on the pad)" : "Text";
    $("edit-dialog").classList.toggle("record-first", !!recordFirst);
    $("edit-text").required = !recordFirst; // a recording can be saved before it has a label
    updateRecUI();
    $("edit-dialog").showModal();
    if (recordFirst) startRecording();   // the microphone starts at once; the label can be typed after
    else if (!id) $("edit-text").focus();
  }

  function updateRecUI() {
    var has = recIds.has(editingId);
    var supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    $("rec-status").textContent = !supported
      ? "This browser cannot record audio here. Recording needs a secure page (https or localhost)."
      : has ? "Your recording plays instead of the system voice."
            : "No recording. The system voice reads this comment.";
    $("rec-start").disabled = !supported;
    $("rec-start").textContent = has ? "Record again" : "Record";
    $("rec-play").hidden = !has;
    $("rec-delete").hidden = !has;
  }

  function startRecording() {
    if (recorder) { recorder.stop(); return; }
    stopAll();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var chunks = [];
      var mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(function (m) {
        return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m);
      });
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      var id = editingId;
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = function () {
        clearTimeout(recTimer);
        stream.getTracks().forEach(function (t) { t.stop(); });
        $("rec-box").classList.remove("recording");
        recorder = null;
        var blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : (mime || "audio/webm") });
        if (!blob.size) { updateRecUI(); toast("Nothing was recorded. Check the microphone."); return; }
        recPut(id, blob).then(function () {
          recIds.add(id);
          if (editingId === id) { updateRecUI(); if (!$("edit-text").value) $("edit-text").focus(); }
          render();
          toast("Recording saved.");
        }).catch(function () { toast("The recording could not be saved in this browser."); updateRecUI(); });
      };
      recorder.start();
      $("rec-box").classList.add("recording");
      $("rec-status").textContent = "Recording. Read the comment, then press Stop (it stops by itself after 8 seconds).";
      $("rec-start").textContent = "Stop";
      recTimer = setTimeout(function () { if (recorder) recorder.stop(); }, MAX_REC_MS);
    }).catch(function () {
      toast("Microphone access was refused. Allow it in the browser's or system's settings to record.");
    });
  }

  function wireEditor() {
    var dlg = $("edit-dialog");
    $("rec-start").addEventListener("click", startRecording);
    $("rec-play").addEventListener("click", function () {
      var c = byId(editingId) || { id: editingId, text: $("edit-text").value || "…", severity: $("edit-severity").value };
      play(c, null);
    });
    $("rec-delete").addEventListener("click", function () {
      var id = editingId;
      recDel(id).then(function () { recIds.delete(id); updateRecUI(); render(); toast("Recording deleted."); });
    });
    $("edit-delete").addEventListener("click", function () {
      var id = editingId;
      state.comments = state.comments.filter(function (c) { return c.id !== id; });
      unplace(id);
      recDel(id).catch(function () {});
      recIds.delete(id);
      dlg.close("deleted");
      commit();
      toast("Comment deleted.");
    });
    dlg.addEventListener("close", function () {
      if (recorder) recorder.stop();
      var text = $("edit-text").value.trim().slice(0, 140);
      if (!text && draft && recIds.has(draft.id)) text = "Recorded comment";
      if (dlg.returnValue === "save" && text) {
        if (draft) {
          state.comments.push({ id: draft.id, text: text, severity: $("edit-severity").value, random: $("edit-random").checked });
          var slots = state.banks[draft.bank];
          var i = slots[draft.slot] === null ? draft.slot : slots.indexOf(null);
          if (i >= 0) slots[i] = draft.id;
          else toast("That bank filled up, so the comment went to the reserve.");
        } else {
          var c = byId(editingId);
          if (c) {
            c.text = text;
            c.severity = $("edit-severity").value;
            c.random = $("edit-random").checked;
          }
        }
        commit();
      } else if (draft && dlg.returnValue !== "deleted") {
        // A new comment that was never saved: drop any recording made for it.
        var orphan = draft.id;
        recDel(orphan).catch(function () {});
        recIds.delete(orphan);
      }
      draft = null;
      editingId = null;
    });
  }

  // -------------------------------------------------------------- settings

  // Where to get better voices, for the system this page is running on.
  function voiceTip() {
    var ua = navigator.userAgent || "";
    var touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports itself as a Mac
    if (/iPhone|iPad|iPod/.test(ua) || touchMac)
      return "Better voices can be downloaded in Settings, Accessibility, Spoken Content, Voices.";
    if (/Android/.test(ua))
      return "Voices are set in the system settings under Text-to-speech output.";
    if (/Mac OS X|Macintosh/.test(ua))
      return "Better voices (Enhanced or Premium) can be downloaded in System Settings, Accessibility, Spoken Content, System voice, Manage Voices. Restart the app afterwards.";
    if (/Windows/.test(ua))
      return "More voices can be added in Settings, Time & language, Speech, Add voices. Restart the app afterwards.";
    if (/Linux/.test(ua))
      return "On Linux the voices come from speech-dispatcher (for example espeak-ng or RHVoice).";
    return "";
  }

  // Voice picker: a custom list, because a native <select> cannot fold its
  // groups. "Recommended" is always open; the other two start closed every time
  // the list opens and fold on click. A closed group holding the chosen voice
  // is marked in the selection colour.
  var openGroups = { other: false, novelty: false };

  var effectiveURI = null; // the voice actually used: the one chosen, or the default pick

  function voiceOption(v, label) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "voice-opt";
    b.setAttribute("role", "option");
    var uri = v ? v.voiceURI : null;
    var selected = uri === effectiveURI;
    b.setAttribute("aria-selected", String(selected));
    var name = document.createElement("span");
    name.textContent = label || voiceName(v);
    b.appendChild(name);
    if (v) { var l = document.createElement("small"); l.textContent = v.lang; b.appendChild(l); }
    b.addEventListener("click", function () {
      state.settings.voiceURI = uri;
      save();
      toggleVoiceList(false);
      renderVoiceSelect();
      $("voice-picker").focus();
    });
    return b;
  }

  function renderVoiceSelect() {
    var list = langVoices();
    var groups = { recommended: [], other: [], novelty: [] };
    list.forEach(function (v) { groups[voiceGroup(v)].push(v); });
    groups.recommended.sort(function (a, b) { return voiceRank(a) - voiceRank(b) || a.name.localeCompare(b.name); });

    // No "Automatic" entry: until a voice is chosen, the default pick is shown
    // (and ticked) like any other.
    var chosen = list.find(function (v) { return v.voiceURI === state.settings.voiceURI; }) || pickVoice();
    effectiveURI = chosen ? chosen.voiceURI : null;
    $("voice-current").textContent = chosen ? voiceName(chosen) + " (" + chosen.lang + ")" : "No voice available";

    var box = $("voice-list");
    box.replaceChildren();
    [["recommended", "Recommended"], ["other", "Other English voices"], ["novelty", "Special voices"]].forEach(function (g) {
      var key = g[0], items = groups[key];
      if (!items.length) return;
      var head;
      if (key === "recommended") {
        head = document.createElement("div");
        head.className = "voice-group";
        head.textContent = g[1];
      } else {
        head = document.createElement("button");
        head.type = "button";
        head.className = "voice-group toggle";
        head.setAttribute("aria-expanded", String(openGroups[key]));
        head.textContent = g[1] + " (" + items.length + ")";
        if (chosen && voiceGroup(chosen) === key) {
          head.classList.add("has-selected");
          head.title = "The chosen voice, " + chosen.name + ", is in this group";
        }
        head.addEventListener("click", function () { openGroups[key] = !openGroups[key]; renderVoiceSelect(); });
      }
      box.appendChild(head);
      if (key === "recommended" || openGroups[key]) items.forEach(function (v) { box.appendChild(voiceOption(v)); });
    });

    // Only problems are shown inline; the advice on better voices sits behind "Better voices".
    $("voice-note").textContent = !synth
      ? "This browser has no speech synthesis. Recorded comments still play."
      : voices.length ? "" : "No voices found yet. Some browsers load them after the first comment is played.";
    $("voice-note").hidden = !$("voice-note").textContent;
    $("voice-help-text").textContent = voiceTip();
  }

  function toggleVoiceList(on) {
    var box = $("voice-list");
    if (on === undefined) on = box.hidden;
    if (on && box.hidden) { openGroups.other = false; openGroups.novelty = false; renderVoiceSelect(); }
    box.hidden = !on;
    $("voice-picker").setAttribute("aria-expanded", String(on));
    if (on) {
      var sel = box.querySelector('[aria-selected="true"]');
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }
  }

  function wireSettings() {
    var dlg = $("settings");
    $("settings-open").addEventListener("click", function () {
      $("rate").value = state.settings.rate;
      $("pitch").value = state.settings.pitch;
      $("rate-out").textContent = Number(state.settings.rate).toFixed(2);
      $("pitch-out").textContent = Number(state.settings.pitch).toFixed(2);
      document.querySelectorAll('input[name="random-from"]').forEach(function (r) { r.checked = r.value === state.settings.randomFrom; });
      renderVoiceSelect();
      toggleVoiceList(false);
      dlg.showModal();
    });
    $("voice-picker").addEventListener("click", function () { toggleVoiceList(); });
    $("voice-help").addEventListener("click", function () { $("voice-help-dialog").showModal(); });
    $("rate").addEventListener("input", function (e) { state.settings.rate = Number(e.target.value); $("rate-out").textContent = state.settings.rate.toFixed(2); save(); });
    $("pitch").addEventListener("input", function (e) { state.settings.pitch = Number(e.target.value); $("pitch-out").textContent = state.settings.pitch.toFixed(2); save(); });
    $("voice-test").addEventListener("click", function () { stopAll(); speak("Why should I care?", function () {}); });
    document.querySelectorAll('input[name="random-from"]').forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) { state.settings.randomFrom = r.value; save(); } });
    });
    $("export-btn").addEventListener("click", exportBoard);
    $("import-btn").addEventListener("click", function () { $("import-file").click(); });
    $("import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) importBoard(f);
    });
    $("reset-btn").addEventListener("click", function () {
      if (!window.confirm("Replace your board with the Reviewer 2 preset? Your comments, banks and recordings will be deleted.")) return;
      var keep = state.settings;
      state = fromPreset(PRESETS[0]);
      state.settings = keep;
      state.settings.bank = "A";
      recClear().catch(function () {});
      recIds.clear();
      commit();
      toast("Board reset to the Reviewer 2 preset.");
    });
  }

  // --------------------------------------------------------- export/import

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(url) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(url || "");
    if (!m || !/^audio\//.test(m[1]) || !m[2]) return null;
    var bin = atob(m[3]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  function exportBoard() {
    var ids = state.comments.map(function (c) { return c.id; }).filter(function (id) { return recIds.has(id); });
    Promise.all(ids.map(function (id) {
      return recGet(id).then(function (b) { return b ? blobToDataURL(b).then(function (u) { return [id, u]; }) : null; });
    })).then(function (pairs) {
      var recordings = {};
      pairs.forEach(function (p) { if (p) recordings[p[0]] = p[1]; });
      var out = {
        format: "desk-reject-board",
        version: 2,
        name: state.name,
        lang: state.lang,
        comments: state.comments,
        banks: state.banks,
        recordings: recordings
      };
      var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "desk-reject-board.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast("Board exported" + (ids.length ? " with " + ids.length + " recording" + (ids.length > 1 ? "s" : "") : "") + ".");
    });
  }

  function importBoard(file) {
    if (file.size > 25 * 1024 * 1024) { toast("That file is larger than 25 MB, so it was not imported."); return; }
    file.text().then(function (txt) {
      var raw = JSON.parse(txt);
      if (raw.format !== "desk-reject-board") throw new Error("format");
      var b = sanitizeBoard(Object.assign({}, raw, { settings: state.settings }));
      if (!b || !b.comments.length) throw new Error("empty");
      var recs = raw.recordings && typeof raw.recordings === "object" ? raw.recordings : {};
      var known = new Set(b.comments.map(function (c) { return c.id; }));
      return recClear().catch(function () {}).then(function () {
        recIds.clear();
        var jobs = Object.keys(recs).filter(function (id) { return known.has(id); }).map(function (id) {
          var blob = dataURLToBlob(recs[id]);
          return blob ? recPut(id, blob).then(function () { recIds.add(id); }) : null;
        });
        return Promise.all(jobs);
      }).then(function () {
        state = b;
        commit();
        toast("Imported “" + b.name + "” with " + b.comments.length + " comments.");
      });
    }).catch(function () {
      toast("This file is not a Desk Reject board. Export one from Settings to see the format.");
    });
  }

  // --------------------------------------------------------------- toasts

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }

  // ------------------------------------------------------------ keyboard

  function wireKeys() {
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") { stopAll(); return; }
      if (e.key === " " && !/^(BUTTON|A)$/.test(tag)) { e.preventDefault(); playRandom(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        var i = BANKS.indexOf(bank()) + (e.key === "ArrowRight" ? 1 : -1);
        if (i >= 0 && i < BANKS.length) { e.preventDefault(); selectBank(BANKS[i]); }
        return;
      }
      var idx = PAD_CODES.indexOf(e.code);
      if (idx >= 0) {
        var c = padsOf(bank())[idx];
        if (c) {
          e.preventDefault();
          play(c, padButton(c.id));
        }
      }
    });
  }

  // ----------------------------------------------------------------- boot

  function boot() {
    var n = String(Math.floor(Math.random() * 9000) + 1000);
    $("ms-number").textContent = "Manuscript DR-" + new Date().getFullYear() + "-" + n;

    // On GitHub Pages (user.github.io/repo) point "Source code" at the repo;
    // elsewhere drop the link rather than show a dead one.
    var link = $("source-link");
    var gh = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
    var repo = location.pathname.split("/").filter(Boolean)[0];
    if (window.deskReject && window.deskReject.repoURL) link.href = window.deskReject.repoURL;
    else if (gh && repo) link.href = "https://github.com/" + gh[1] + "/" + repo;
    else link.replaceWith(document.createTextNode(""));

    $("random-btn").addEventListener("click", playRandom);
    $("edit-toggle").addEventListener("click", function () { editing = !editing; render(); });
    $("add-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var text = $("add-text").value.trim();
      if (!text) return;
      var c = { id: uid(), text: text.slice(0, 140), severity: $("add-severity").value, random: true };
      state.comments.push(c);
      var i = firstFree(bank());
      if (i >= 0) state.banks[bank()][i] = c.id;
      $("add-text").value = "";
      commit();
      toast(i >= 0 ? "Added on pad " + PAD_LABELS[i] + " of bank " + bank() + "." : "Bank " + bank() + " is full, so the comment went to the reserve.");
    });

    wireEditor();
    wirePicker();
    wireSettings();
    wireKeys();

    if (synth) {
      loadVoices();
      if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", loadVoices);
      else synth.onvoiceschanged = loadVoices;
    }

    recKeys().then(function (keys) { (keys || []).forEach(function (k) { recIds.add(k); }); render(); })
      .catch(function () { render(); });
    render();

    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }

  boot();
})();
