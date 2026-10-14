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
  // Pad banks, as on an MPC: A-H at most, letters always contiguous.
  var ALL_BANKS = "ABCDEFGH".split("");
  var MAX_BANKS = ALL_BANKS.length;
  var DEFAULT_BANKS = 4; // a new board has A-D; + adds up to H, × in Edit pads removes (one always stays)
  var PADS = 16;
  // Pads are laid out 4 x 4, like a drum machine: keys follow the physical grid
  // (e.code), so they stay in place on any keyboard layout.
  var PAD_CODES = ["Digit1", "Digit2", "Digit3", "Digit4", "KeyQ", "KeyW", "KeyE", "KeyR",
                   "KeyA", "KeyS", "KeyD", "KeyF", "KeyZ", "KeyX", "KeyC", "KeyV"];
  var PAD_LABELS = "1234QWERASDFZXCV".split("");
  var LONG_PRESS_MS = 550;
  // Revision of the built-in preset. Boards saved with an older one get the
  // new preset comments added (see upgradeFromPreset); 2 = bank B with the harsher comments,
  // 3 = banks added and removed by the user, bank B ordered by colour; 4 = C and D back by default.
  var PRESET_REV = 4;
  // Where the code lives, for the "Source code" link when the page is served
  // from a custom domain (e.g. marcorosso.com/desk-reject/).
  var HOME_REPO = "https://github.com/marcorosso768/desk-reject";

  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------ state

  function uid() {
    return "c" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }

  function emptyBanks(count) {
    var b = {};
    ALL_BANKS.slice(0, clamp(count || DEFAULT_BANKS, 1, MAX_BANKS)).forEach(function (n) { b[n] = new Array(PADS).fill(null); });
    return b;
  }
  // the letters in use, in order
  function lettersOf(banks) { return ALL_BANKS.filter(function (n) { return Array.isArray(banks[n]); }); }

  function defaultSettings() {
    return { voiceURI: null, rate: 1, pitch: 1, randomFrom: "all", allVoices: false, bank: "A", globalKeys: false, effects: true, responses: true };
  }

  // Fill banks in order with the ids of comments flagged board: true (older
  // boards and the presets use that flag); anything beyond 64 goes to the reserve.
  function banksFromFlags(comments, flags) {
    var onBoard = flags.filter(Boolean).length;
    var banks = emptyBanks(Math.max(DEFAULT_BANKS, Math.ceil(onBoard / PADS)));
    var n = 0;
    comments.forEach(function (c, i) {
      if (!flags[i] || n >= MAX_BANKS * PADS) return;
      banks[ALL_BANKS[Math.floor(n / PADS)]][n % PADS] = c.id;
      n += 1;
    });
    return banks;
  }

  // A session is one "manuscript" being refereed: its number, the round, and
  // the comments played so far (for the referee report).
  function newSession(prev) {
    return {
      ms: "DR-" + new Date().getFullYear() + "-" + String(Math.floor(Math.random() * 9000) + 1000),
      round: 1,
      title: prev ? prev.title : "",
      presenter: prev ? prev.presenter : "",
      started: new Date().toISOString(),
      log: []
    };
  }

  function sanitizeSession(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.ms !== "string") return newSession();
    return {
      ms: raw.ms.slice(0, 24),
      round: Math.max(1, Math.min(99, parseInt(raw.round, 10) || 1)),
      title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
      presenter: typeof raw.presenter === "string" ? raw.presenter.slice(0, 120) : "",
      started: typeof raw.started === "string" ? raw.started : new Date().toISOString(),
      log: (Array.isArray(raw.log) ? raw.log : []).filter(function (e) { return e && typeof e.text === "string"; }).slice(-500)
        .map(function (e) { return { text: e.text.slice(0, 140), severity: SEVERITIES.indexOf(e.severity) >= 0 ? e.severity : "comment", t: e.t || "" }; })
    };
  }

  function sanitizeBankNames(raw) {
    var out = {};
    ALL_BANKS.forEach(function (n) { if (raw && typeof raw[n] === "string" && raw[n].trim()) out[n] = raw[n].trim().slice(0, 30); });
    return out;
  }

  function fromPreset(preset) {
    var comments = preset.comments.map(function (c) {
      return { id: uid(), text: c.text, severity: c.severity || "comment", random: c.random !== false, voice: null };
    });
    return {
      version: 2,
      name: preset.name,
      lang: preset.lang || "en",
      comments: comments,
      banks: banksFromFlags(comments, preset.comments.map(function (c) { return c.board !== false; })),
      bankNames: sanitizeBankNames(preset.bankNames),
      presetRev: PRESET_REV,
      session: newSession(),
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
        random: c.random !== false,
        // reserved for per-comment voices (several languages on one board)
        voice: typeof c.voice === "string" ? c.voice.slice(0, 40) : null
      };
    });

    var banks;
    if (raw.banks && typeof raw.banks === "object") {
      var last = -1;
      ALL_BANKS.forEach(function (n, k) { if (Array.isArray(raw.banks[n])) last = k; });
      banks = emptyBanks(last + 1); // gaps are filled: letters stay contiguous
      var placed = new Set();
      lettersOf(banks).forEach(function (n) {
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
      bankNames: sanitizeBankNames(raw.bankNames),
      presetRev: parseInt(raw.presetRev, 10) || 1,
      session: sanitizeSession(raw.session),
      settings: {
        voiceURI: typeof s.voiceURI === "string" ? s.voiceURI : null,
        rate: clamp(Number(s.rate) || 1, 0.6, 1.6),
        pitch: clamp(Number(s.pitch) || 1, 0.5, 1.5),
        randomFrom: s.randomFrom === "board" ? "board" : "all",
        allVoices: !!s.allVoices,
        bank: banks[s.bank] ? s.bank : "A",
        globalKeys: !!s.globalKeys,
        effects: s.effects !== false,
        responses: s.responses !== false
      }
    };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // A board saved with an older preset keeps everything the user did, and gains
  // the comments added to the preset since: if bank B is still empty they fill
  // it as in the preset, otherwise they wait in the reserve.
  var upgradedPreset = false, filledBankB = false, presetUpgraded = false;
  function addPresetRev2(b) {
    if (b.presetRev >= 2) return;
    var byText = new Map(b.comments.map(function (c) { return [c.text.trim().toLowerCase(), c]; }));
    var onPad = new Set();
    lettersOf(b.banks).forEach(function (k) { b.banks[k].forEach(function (id) { if (id) onPad.add(id); }); });
    var bEmpty = !b.banks.B.some(Boolean);
    var pads = 0, added = 0, filled = 0;
    PRESETS[0].comments.forEach(function (pc) {
      var slot = pc.board !== false ? pads++ : -1; // position in the preset: 0-15 bank A, 16-31 bank B
      var c = byText.get(pc.text.trim().toLowerCase());
      if (!c) {
        c = { id: uid(), text: pc.text, severity: pc.severity || "comment", random: pc.random !== false, voice: null };
        b.comments.push(c);
        added += 1;
      }
      // fill an empty bank B with the preset's bank B, reusing a comment already in the reserve
      if (bEmpty && slot >= PADS && slot < 2 * PADS && !onPad.has(c.id)) {
        b.banks.B[slot - PADS] = c.id;
        onPad.add(c.id);
        filled += 1;
      }
    });
    b.bankNames = {}; // banks are shown by letter only
    filledBankB = filled > 0;
    upgradedPreset = added > 0 || filled > 0;
  }

  // Preset B as it is now (pads 17-32 of the preset), lower-cased texts.
  function presetBankB() {
    return PRESETS[0].comments.filter(function (c) { return c.board !== false; })
      .slice(PADS, 2 * PADS).map(function (c) { return c.text.trim().toLowerCase(); });
  }

  function upgradeFromPreset(b) {
    if (!PRESETS[0] || b.presetRev >= PRESET_REV) return b;
    addPresetRev2(b);
    if (b.presetRev < 3) {
      // 3: bank B, if untouched, takes the preset's new order (by colour, like A)
      if (b.banks.B) {
        var want = presetBankB();
        var cur = b.banks.B.map(function (id) {
          var c = id && b.comments.find(function (x) { return x.id === id; });
          return c ? c.text.trim().toLowerCase() : null;
        });
        var same = cur.every(Boolean) && cur.slice().sort().join("|") === want.slice().sort().join("|");
        if (same) {
          var idOf = {};
          cur.forEach(function (t, i) { idOf[t] = b.banks.B[i]; });
          b.banks.B = want.map(function (t) { return idOf[t]; });
        }
      }
      if (!b.banks[b.settings.bank]) b.settings.bank = "A";
    }
    if (b.presetRev < 4) {
      // 4: boards trimmed to A-B by 1.2.x get the empty C and D back
      var have = lettersOf(b.banks).length;
      ALL_BANKS.slice(have, DEFAULT_BANKS).forEach(function (n) { b.banks[n] = new Array(PADS).fill(null); });
    }
    b.presetRev = PRESET_REV;
    presetUpgraded = true;
    return b;
  }

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY));
      var b = sanitizeBoard(raw);
      if (b) return upgradeFromPreset(b);
    } catch (e) { /* private mode or corrupt: fall through */ }
    return fromPreset(PRESETS[0]);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // a first visit (no saved board yet) gets the welcome tour instead of the news
  var isNewInstall = (function () { try { return !localStorage.getItem(STORE_KEY); } catch (e) { return false; } })();
  var state = load();
  var recIds = new Set();
  var editing = false;
  var lastRandomId = null;

  // ------------------------------------------------------------ bank helpers

  function byId(id) { return state.comments.find(function (c) { return c.id === id; }) || null; }
  function bank() { return state.settings.bank; }
  function banksIn() { return lettersOf(state.banks); }

  function slotOf(id) {
    var letters = banksIn();
    for (var b = 0; b < letters.length; b++) {
      var i = state.banks[letters[b]].indexOf(id);
      if (i >= 0) return { bank: letters[b], slot: i };
    }
    return null;
  }

  function padsOf(name) { return state.banks[name].map(function (id) { return id ? byId(id) : null; }); }
  function firstFree(name) { return state.banks[name].indexOf(null); }
  function unplace(id) { banksIn().forEach(function (n) { var i = state.banks[n].indexOf(id); if (i >= 0) state.banks[n][i] = null; }); }
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

  function play(comment, btn, opts) {
    stopAll();
    showVerdict(comment);
    if (!(opts && opts.preview)) logComment(comment);
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

  function logComment(c) {
    state.session.log.push({ text: c.text, severity: c.severity, t: new Date().toISOString() });
    Stats.record(c, state.session);
    save();
    renderMasthead();
  }

  function renderMasthead() {
    var n = state.session.log.length;
    $("ms-number").textContent = "Manuscript " + state.session.ms;
    $("ms-round").textContent = state.session.round + (n ? " · " + n + " comment" + (n > 1 ? "s" : "") : "");
  }

  function showVerdict(c) {
    var q = $("verdict-quote");
    q.textContent = "“" + c.text + "”";
    q.dataset.sev = c.severity;
    q.classList.remove("typeset");
    void q.offsetWidth;
    q.classList.add("typeset");
    $("verdict-label").textContent = "Reviewer 2 writes:";
  }

  function clearVerdict() {
    var q = $("verdict-quote");
    q.textContent = "";
    delete q.dataset.sev;
    q.classList.remove("typeset");
    $("verdict-label").textContent = "Reviewer 2 is waiting for your paper.";
  }

  // Swipe left / right on the pads: next / previous pad bank (touch screens).
  var lastSwipe = 0;
  function wireSwipe() {
    var board = $("board"), t0 = null;
    board.addEventListener("touchstart", function (e) {
      t0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
    }, { passive: true });
    board.addEventListener("touchend", function (e) {
      if (!t0 || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - t0.x, dy = e.changedTouches[0].clientY - t0.y, dt = Date.now() - t0.t;
      t0 = null;
      if (dt > 700 || Math.abs(dx) < 45 || Math.abs(dx) < 1.6 * Math.abs(dy)) return;
      lastSwipe = Date.now();
      bankSwipe(dx < 0 ? 1 : -1);
    });
    function bankSwipe(step) {
      var ok = runAction({ type: "bank", step: step });
      board.classList.remove("swipe-next", "swipe-prev", "swipe-edge");
      void board.offsetWidth;
      board.classList.add(ok ? (step > 0 ? "swipe-next" : "swipe-prev") : "swipe-edge");
    }
    // Two-finger swipe on a trackpad arrives as horizontal wheel events, with
    // inertia. It works anywhere in the window (not only over the pads), and
    // one gesture moves one bank. While the inertia of a swipe is still
    // arriving, a new swipe is recognised when the direction flips (inertia
    // never reverses) or when the deltas grow again after fading.
    var acc = 0, locked = 0, quiet = null, trough = Infinity;
    window.addEventListener("wheel", function (e) {
      if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return;
      if (document.querySelector("dialog[open]") || (typeof Tour !== "undefined" && Tour.isOpen())) return;
      e.preventDefault(); // no back / forward page swipe in the browser
      var dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX, dir = dx > 0 ? 1 : -1, abs = Math.abs(dx);
      clearTimeout(quiet);
      quiet = setTimeout(function () { acc = 0; locked = 0; trough = Infinity; }, 160);
      if (locked) {
        var reversed = dir !== locked && abs > 3;
        var renewed = dir === locked && trough < 6 && abs > Math.max(10, trough * 3);
        trough = Math.min(trough, abs);
        if (!reversed && !renewed) return;
        locked = 0; acc = 0;
      }
      if (acc && (acc > 0) !== (dx > 0)) acc = 0; // a change of mind restarts the count
      acc += dx;
      if (Math.abs(acc) < 40) return;
      locked = acc > 0 ? 1 : -1;
      acc = 0; trough = Infinity;
      bankSwipe(locked);
    }, { passive: false });
    board.addEventListener("animationend", function () { board.classList.remove("swipe-next", "swipe-prev", "swipe-edge"); });
  }

  function attachPadGestures(btn, onTap, onHold) {
    // Long press (touch) or right click opens the editor, so any pad can be
    // rewritten or recorded without entering edit mode.
    var pressTimer = null, longPressed = false, sx = 0, sy = 0;
    btn.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      longPressed = false;
      sx = e.clientX; sy = e.clientY;
      pressTimer = setTimeout(function () { longPressed = true; onHold(); }, LONG_PRESS_MS);
    });
    btn.addEventListener("pointermove", function (e) {
      if (pressTimer && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 12) { clearTimeout(pressTimer); pressTimer = null; }
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearTimeout(pressTimer); });
    });
    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); clearTimeout(pressTimer); if (!longPressed) onHold(); });
    btn.addEventListener("click", function () {
      if (longPressed) { longPressed = false; return; }
      if (Date.now() - lastSwipe < 500) return; // the finger was swiping, not tapping
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
    if (!onPad) { var where = slotOf(c.id); if (where) marks.push("pad bank " + where.bank); }
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
        tool("Add to pad", "Add “" + c.text + "” to the first free pad of pad bank " + bank(), function () { putOnPad(c.id); })
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
    btn.setAttribute("aria-label", "Add a comment on pad " + PAD_LABELS[slot] + " of pad bank " + bank());
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
    if (i < 0) { toast("Pad bank " + name + " is full."); return; }
    unplace(id);
    state.banks[name][i] = id;
    commit();
    toast("Moved to pad " + PAD_LABELS[i] + " of pad bank " + name + ".");
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
    var letters = banksIn();
    letters.forEach(function (n) {
      var slot = document.createElement("span");
      slot.className = "bank-slot";
      var b = document.createElement("button");
      b.type = "button";
      b.className = "bank-btn";
      b.textContent = n;
      b.setAttribute("aria-pressed", String(n === bank()));
      b.setAttribute("aria-label", "Pad bank " + n + (bankUsed(n) ? "" : ", empty"));
      if (bankUsed(n)) b.classList.add("used");
      b.addEventListener("click", function () { selectBank(n); });
      makeDropTarget(b, function (id) { dropOnBank(id, n); });
      slot.appendChild(b);
      if (editing && letters.length > 1) {
        var x = document.createElement("button");
        x.type = "button";
        x.className = "bank-remove";
        x.textContent = "×";
        x.title = "Remove pad bank " + n;
        x.setAttribute("aria-label", "Remove pad bank " + n);
        x.addEventListener("click", function (e) { e.stopPropagation(); removeBank(n); });
        slot.appendChild(x);
      }
      bar.appendChild(slot);
    });
    if (letters.length < MAX_BANKS) {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "bank-btn bank-add";
      add.textContent = "+";
      add.title = "Add pad bank " + ALL_BANKS[letters.length];
      add.setAttribute("aria-label", "Add pad bank " + ALL_BANKS[letters.length]);
      add.addEventListener("click", addBank);
      bar.appendChild(add);
    }
  }

  function addBank() {
    var letters = banksIn();
    if (letters.length >= MAX_BANKS) return;
    var n = ALL_BANKS[letters.length];
    state.banks[n] = new Array(PADS).fill(null);
    state.settings.bank = n;
    commit();
    toast("Added pad bank " + n + ".");
  }

  function removeBank(n) {
    var letters = banksIn();
    if (letters.length < 2 || !state.banks[n]) return;
    if (bankUsed(n) && !window.confirm("Remove pad bank " + n + "? Its comments stay in the reserve.")) return;
    var keep = letters.filter(function (k) { return k !== n; });
    var cur = bank(), banks = {};
    keep.forEach(function (k, i) { banks[ALL_BANKS[i]] = state.banks[k]; });
    // the later banks move up one letter, and so does the selection
    var pos = cur === n ? Math.max(0, letters.indexOf(n) - 1) : keep.indexOf(cur);
    state.banks = banks;
    state.bankNames = {};
    state.settings.bank = ALL_BANKS[pos];
    commit();
    toast("Removed pad bank " + n + (letters.indexOf(n) < letters.length - 1 ? "; the ones after it moved up a letter." : "."));
  }

  function render() {
    var board = $("board"), lib = $("library");
    board.replaceChildren();
    lib.replaceChildren();
    padsOf(bank()).forEach(function (c, i) { board.appendChild(c ? commentItem(c, i) : emptyItem(i)); });
    var placed = new Set();
    banksIn().forEach(function (n) { state.banks[n].forEach(function (id) { if (id) placed.add(id); }); });
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
    return w ? "Pad bank " + w.bank + " · " + PAD_LABELS[w.slot] : "Reserve";
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
        toast("“" + c.text + "” is now on pad " + PAD_LABELS[slot] + " of pad bank " + bank() + ".");
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
    $("pick-title").textContent = "Pad " + PAD_LABELS[slot] + ", pad bank " + bank();
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
    if (!state.banks[n] || n === bank()) return;
    state.settings.bank = n;
    commit();
  }

  function putOnPad(id) {
    var i = firstFree(bank());
    if (i < 0) { toast("Pad bank " + bank() + " is full. Take a comment off a pad, or switch pad bank."); return; }
    unplace(id);
    state.banks[bank()][i] = id;
    commit();
    toast("Now on pad " + PAD_LABELS[i] + " of pad bank " + bank() + ".");
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
      $("edit-title").textContent = (recordFirst ? "Record a new comment" : "New comment") + ", pad " + PAD_LABELS[newSlot.slot] + " of pad bank " + newSlot.bank;
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
      play(c, null, { preview: true });
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
          else toast("That pad bank filled up, so the comment went to the reserve.");
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
      $("effects").checked = !!state.settings.effects;
      Stats.render();
      dlg.showModal();
    });
    $("voice-picker").addEventListener("click", function () { toggleVoiceList(); });
    if (window.deskReject && window.deskReject.setGlobalShortcuts) {
      $("global-keys-box").hidden = false;
      var mac = window.deskReject.platform === "darwin";
      $("global-keys-combo").textContent = mac ? "Control + Option" : "Ctrl + Alt";
      $("global-keys").checked = !!state.settings.globalKeys;
      $("global-keys").addEventListener("change", function (e) { state.settings.globalKeys = e.target.checked; save(); applyGlobalKeys(); });
    }
    $("voice-help").addEventListener("click", function () { $("voice-help-dialog").showModal(); });
    $("effects").addEventListener("change", function (e) { state.settings.effects = e.target.checked; save(); if (e.target.checked) Fx.preview(); });
    $("stats-reset").addEventListener("click", function () {
      if (!window.confirm("Reset the statistics? Your board and the current manuscript are kept.")) return;
      Stats.reset(); Stats.render();
    });
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
      if (!window.confirm("Replace your board with the Reviewer 2 preset? Your comments, pad banks and recordings will be deleted.")) return;
      var keep = state.settings;
      var keepSession = state.session;
      state = fromPreset(PRESETS[0]);
      state.settings = keep;
      state.session = keepSession;
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
        bankNames: state.bankNames,
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
        b.session = state.session; // an imported board does not end the current manuscript
        b.presetRev = PRESET_REV;  // and is taken as it is, without preset additions
        state = b;
        commit();
        toast("Imported “" + b.name + "” with " + b.comments.length + " comments.");
      });
    }).catch(function () {
      toast("This file is not a Desk Reject board. Export one from Settings to see the format.");
    });
  }

  // --------------------------------------------------------- referee report
  // The comments played since the manuscript was opened become a decision
  // letter. "Next round" keeps the manuscript and starts an empty round; "New
  // manuscript" starts over with a new number.

  var SEV_LABEL = { comment: "Comment", revise: "Revise", reject: "Reject" };
  // The desktop app saves through the system's Save dialog; the web app downloads.
  var desktopSave = !!(window.deskReject && window.deskReject.savePdf);
  var PDF_LABEL = desktopSave ? "Save PDF" : "Download PDF";
  var SITE_URL = "https://marcorosso.com/desk-reject/";

  function decide(log) {
    var n = log.length;
    var count = { comment: 0, revise: 0, reject: 0 };
    log.forEach(function (e) { count[e.severity] = (count[e.severity] || 0) + 1; });
    var d;
    if (n < 3) d = { label: "Accept", note: "Reviewer 2 fell asleep before reaching the third comment." };
    else if (log.some(function (e) { return /desk reject/i.test(e.text); })) d = { label: "Desk reject", note: "The manuscript was desk rejected before the end of the first page. The editor did not object." };
    else if (count.reject * 3 >= n) d = { label: "Reject", note: "At least a third of the comments call for rejection. The editor follows Reviewer 2, as always." };
    else if (count.revise >= count.comment) d = { label: "Major revision", note: "The concerns are mostly about identification. Please address every comment; Reviewer 2 will check." };
    else d = { label: "Minor revision", note: "Reviewer 2 is almost satisfied, which has never happened before." };
    d.count = count;
    d.n = n;
    return d;
  }

  var lastFxKey = null;

  function renderReport() {
    var s = state.session;
    var d = decide(s.log);
    $("report-ms").textContent = s.ms;
    $("report-round").textContent = String(s.round);
    $("report-title-input").value = s.title || "";
    $("report-presenter").value = s.presenter || "";
    $("report-counts").textContent = d.n
      ? d.n + " comment" + (d.n > 1 ? "s" : "") + ": " + d.count.comment + " comment, " + d.count.revise + " revise, " + d.count.reject + " reject."
      : "No comments yet in this round. Play some pads first.";
    $("report-decision").textContent = d.label;
    $("report-decision").dataset.decision = d.label.toLowerCase().replace(/\s+/g, "-");
    $("report-note").textContent = d.note;
    var list = $("report-list");
    list.replaceChildren();
    Report.unique(s.log).forEach(function (e) {
      var li = document.createElement("li");
      li.className = "sev-" + e.severity;
      li.textContent = e.text + (e.n > 1 ? " \u00D7" + e.n : "");
      list.appendChild(li);
    });
    $("report-pdf").disabled = !d.n;
  }

  function wireReport() {
    var dlg = $("report-dialog");
    $("report-pdf").textContent = PDF_LABEL;
    $("report-open").addEventListener("click", function () {
      renderReport();
      dlg.showModal();
      var s = state.session;
      var key = s.ms + "#" + s.round + "#" + s.log.length;
      if (s.log.length && state.settings.effects && key !== lastFxKey) { lastFxKey = key; Fx.decision(decide(s.log).label, dlg); }
    });
    $("report-responses").checked = !!state.settings.responses;
    $("report-responses").addEventListener("change", function (e) { state.settings.responses = e.target.checked; save(); });
    $("report-title-input").addEventListener("input", function (e) { state.session.title = e.target.value.slice(0, 200); save(); });
    $("report-presenter").addEventListener("input", function (e) { state.session.presenter = e.target.value.slice(0, 120); save(); });
    $("report-next").addEventListener("click", function () {
      if (state.session.log.length && !window.confirm("Start round " + (state.session.round + 1) + "? The comments of this round are cleared (download the report first if you want it).")) return;
      state.session.round += 1;
      state.session.log = [];
      save(); renderMasthead(); renderReport();
      toast("Round " + state.session.round + " of " + state.session.ms + ".");
    });
    // "New manuscript" in the report and "New review" in the masthead do the same
    function newReview() {
      if (state.session.log.length && !window.confirm("Start a new review? The comments of manuscript " + state.session.ms + " are cleared (generate the report first if you want it).")) return;
      stopAll();
      state.session = newSession();
      save(); renderMasthead(); clearVerdict();
      if (dlg.open) renderReport();
      toast("New manuscript " + state.session.ms + ".");
    }
    $("report-new").addEventListener("click", newReview);
    $("review-new").addEventListener("click", newReview);
    $("report-pdf").addEventListener("click", function () {
      var btn = $("report-pdf");
      btn.disabled = true;
      btn.textContent = "Preparing…";
      buildReportPdf().then(function (blob) {
        var name = state.session.ms + "-round-" + state.session.round + ".pdf";
        if (desktopSave) {
          return blob.arrayBuffer().then(function (buf) { return window.deskReject.savePdf(name, new Uint8Array(buf)); })
            .then(function (res) { if (res && res.ok) toast("Report saved: " + res.name); });
        }
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast("Report downloaded: " + name);
      }).catch(function (err) {
        toast("The PDF could not be created" + (err && err.message ? ": " + err.message : "."));
      }).then(function () {
        btn.disabled = !state.session.log.length;
        btn.textContent = PDF_LABEL;
      });
    });
  }

  // jsPDF and the Computer Modern fonts are loaded only when a report is made.
  var pdfLibPromise = null;
  function loadPdfLib() {
    if (pdfLibPromise) return pdfLibPromise;
    var script = new Promise(function (resolve, reject) {
      if (window.jspdf) { resolve(); return; }
      var sc = document.createElement("script");
      sc.src = "assets/vendor/jspdf.umd.min.js";
      sc.onload = function () { resolve(); };
      sc.onerror = function () { reject(new Error("could not load the PDF library")); };
      document.head.appendChild(sc);
    });
    var files = ["cmu-serif-500-roman", "cmu-serif-500-italic", "cmu-serif-700-roman", "cmu-sans-serif-700-roman", "cmu-typewriter-text-500-roman"];
    var fonts = Promise.all(files.map(function (f) {
      return fetch("assets/fonts/pdf/" + f + ".ttf").then(function (r) {
        if (!r.ok) throw new Error("font " + f);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf), bin = "";
        for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return [f, btoa(bin)];
      });
    }));
    pdfLibPromise = Promise.all([script, fonts]).then(function (r) { return r[1]; });
    pdfLibPromise.catch(function () { pdfLibPromise = null; });
    return pdfLibPromise;
  }

  function buildReportPdf() {
    return loadPdfLib().then(function (fonts) {
      var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
      var reg = { "cmu-serif-500-roman": ["CMUSerif", "normal"], "cmu-serif-500-italic": ["CMUSerif", "italic"],
                  "cmu-serif-700-roman": ["CMUSerif", "bold"], "cmu-sans-serif-700-roman": ["CMUSans", "bold"],
                  "cmu-typewriter-text-500-roman": ["CMUType", "normal"] };
      fonts.forEach(function (f) { doc.addFileToVFS(f[0] + ".ttf", f[1]); doc.addFont(f[0] + ".ttf", reg[f[0]][0], reg[f[0]][1]); });

      var s = state.session, d = decide(s.log);
      var W = 210, H = 297, M = 25, X = M, R = W - M, y = M;
      var INK = [35, 37, 42], SOFT = [94, 99, 107], RED = [179, 18, 46], BLUE = [29, 79, 160], GREY = [107, 112, 120];
      var SEVCOL = { comment: GREY, revise: BLUE, reject: RED };
      function font(name, style, size, color) { doc.setFont(name, style); doc.setFontSize(size); doc.setTextColor.apply(doc, color || INK); }
      function para(text, size, style, color, gap) {
        font("CMUSerif", style || "normal", size || 11.5, color);
        var lines = doc.splitTextToSize(text, R - X);
        lines.forEach(function (l) { if (y > H - M - 10) { doc.addPage(); y = M; } doc.text(l, X, y); y += (size || 11.5) * 0.48; });
        y += gap === undefined ? 3 : gap;
      }

      // masthead
      font("CMUSans", "bold", 9, SOFT);
      doc.setCharSpace(0.8);
      doc.text("THE DESK REJECT REVIEW", X, y);
      doc.setCharSpace(0);
      font("CMUSerif", "italic", 9.5, SOFT);
      doc.text(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), R, y, { align: "right" });
      y += 3;
      doc.setDrawColor.apply(doc, [211, 214, 219]);
      doc.setLineWidth(0.3);
      doc.line(X, y, R, y);
      y += 12;

      font("CMUSerif", "bold", 19);
      doc.text("Decision letter", X, y);
      y += 9;

      // manuscript data
      var meta = [["Manuscript", s.ms], ["Round", String(s.round)]];
      if (s.title) meta.push(["Title", s.title]);
      if (s.presenter) meta.push(["Presented by", s.presenter]);
      meta.forEach(function (m) {
        font("CMUSerif", "italic", 10.5, SOFT);
        doc.text(m[0], X, y);
        font("CMUSerif", "normal", 10.5);
        var lines = doc.splitTextToSize(m[1], R - X - 30);
        doc.text(lines, X + 30, y);
        y += 5 * lines.length;
      });
      y += 6;

      para("Dear Author(s),", 11.5, "normal", INK, 2);
      para("Thank you for your submission. Reviewer 2 has now read the manuscript (or at least the abstract) and noted down "
        + d.n + " thought" + (d.n > 1 ? "s" : "") + " while reading it. The report follows.", 11.5, "normal", INK, 6);

      // the report, in Reviewer 2's voice: each comment once, from minor to fatal
      var rep = Report.build(s.log);
      font("CMUSerif", "bold", 13);
      doc.text("Report of Reviewer 2", X, y);
      y += 7;
      para(rep.opening, 11.5, "normal", INK, 4);
      rep.sections.forEach(function (sec) {
        if (y > H - M - 30) { doc.addPage(); y = M; }
        font("CMUSans", "bold", 8, SEVCOL[sec.severity] || GREY);
        doc.setCharSpace(0.6);
        doc.text(sec.title.toUpperCase(), X, y);
        doc.setCharSpace(0);
        y += 5;
        para(sec.text, 11.5, "normal", INK, 4);
      });
      para(rep.closing, 11.5, "italic", INK, 2);

      // decision and stamp
      if (y > H - M - 75) { doc.addPage(); y = M; }
      y += 6;
      font("CMUSerif", "italic", 11.5, SOFT);
      doc.text("Decision", X, y);
      y += 8;
      font("CMUSerif", "bold", 18, d.label === "Accept" || d.label === "Minor revision" ? INK : RED);
      doc.text(d.label, X, y);
      y += 7;
      para(d.note, 11.5, "normal", INK, 8);
      if (y > H - M - 52) { doc.addPage(); y = M; }
      var ySign = y;
      para("Yours sincerely,", 11.5, "normal", INK, 1);
      para("Reviewer 2", 11.5, "italic", INK, 1);
      para("on behalf of the Editor", 10.5, "normal", SOFT, 0);
      drawStamp(doc, R - 24, ySign + 16, 21, RED); // beside the signature, below the text

      // the authors' reply: one letter, built from the comments of the round
      if (state.settings.responses && s.log.length) {
        doc.addPage(); y = M;
        font("CMUSans", "bold", 9, SOFT);
        doc.setCharSpace(0.8);
        doc.text("THE DESK REJECT REVIEW", X, y);
        doc.setCharSpace(0);
        font("CMUSerif", "italic", 9.5, SOFT);
        doc.text("Manuscript " + s.ms + ", round " + s.round, R, y, { align: "right" });
        y += 3;
        doc.setDrawColor.apply(doc, [211, 214, 219]);
        doc.setLineWidth(0.3);
        doc.line(X, y, R, y);
        y += 12;
        font("CMUSerif", "bold", 19);
        doc.text("Response to Reviewer 2", X, y);
        y += 10;
        Responses.letter(s.log, d.label).forEach(function (p) { para(p, 11.5, "normal", INK, 3.5); });
        if (y > H - M - 30) { doc.addPage(); y = M; }
        y += 2;
        para("Yours, with all the respect we could find,", 11.5, "normal", INK, 1);
        para(s.presenter ? s.presenter : "The Authors", 11.5, "italic", INK, 0);
      }

      // footer on every page
      var pages = doc.getNumberOfPages();
      for (var p = 1; p <= pages; p++) {
        doc.setPage(p);
        font("CMUSerif", "italic", 8.5, SOFT);
        doc.text("Generated by Desk Reject · " + SITE_URL.replace(/^https?:\/\//, "").replace(/\/$/, ""), X, H - 12);
        if (pages > 1) doc.text(p + " / " + pages, R, H - 12, { align: "right" });
      }
      doc.setProperties({ title: "Decision letter " + s.ms + ", round " + s.round, creator: "Desk Reject" });
      return doc.output("blob");
    });
  }

  // The rubber stamp of the app, drawn with lines and letters (rotated -9°).
  function drawStamp(doc, cx, cy, r, color) {
    var rot = -9 * Math.PI / 180;
    doc.setDrawColor.apply(doc, color);
    doc.setTextColor.apply(doc, color);
    doc.setLineWidth(1.2);
    doc.circle(cx, cy, r, "S");
    doc.setLineWidth(0.5);
    doc.circle(cx, cy, r * 0.62, "S");
    doc.setFont("CMUSans", "bold");
    function arc(text, radius, centerDeg, top) {
      doc.setFontSize(r * 0.62);
      doc.setCharSpace(0);
      var widths = text.split("").map(function (ch) { return doc.getTextWidth(ch) + 0.55; });
      var total = widths.reduce(function (a, b) { return a + b; }, 0);
      var span = total / radius; // radians
      var a = (centerDeg * Math.PI / 180) + rot + (top ? -span / 2 : span / 2);
      text.split("").forEach(function (ch, i) {
        var mid = a + (top ? 1 : -1) * (widths[i] / 2) / radius;
        var x = cx + radius * Math.cos(mid), yy = cy + radius * Math.sin(mid);
        // jsPDF angles are counter-clockwise, in degrees, with y pointing down
        var deg = top ? -(mid * 180 / Math.PI + 90) : -(mid * 180 / Math.PI - 90);
        var w = doc.getTextWidth(ch);
        var ox = (w / 2) * Math.cos(-deg * Math.PI / 180), oy = (w / 2) * Math.sin(-deg * Math.PI / 180);
        doc.text(ch, x - ox, yy - oy, { angle: deg, baseline: "middle" });
        a += (top ? 1 : -1) * widths[i] / radius;
      });
    }
    arc("REVIEWER", r * 0.81, -90, true);
    arc("DECIDES FOR YOU", r * 0.81, 90, false);
    doc.setFontSize(r * 2.0);
    var w2 = doc.getTextWidth("2");
    var deg2 = -rot * 180 / Math.PI;
    doc.text("2", cx - (w2 / 2) * Math.cos(rot), cy - (w2 / 2) * Math.sin(rot), { angle: deg2, baseline: "middle" });
  }

  // ------------------------------------------------------------ decision effects
  // When the report opens, the decision lands as a big rubber stamp with a
  // thud; a reject gets a sad trombone, a major revision a drum roll of doom,
  // an accept or a minor revision a fanfare and confetti. All the sounds are
  // synthesised with Web Audio: no audio files.

  var Fx = (function () {
    var ctx = null;
    function ac() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) ctx = new C();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function noise(c, dur) {
      var b = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = b.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      var src = c.createBufferSource(); src.buffer = b; return src;
    }
    function env(c, t, peak, attack, decay) {
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
      return g;
    }
    // the rubber stamp hitting the desk
    function thud(c, t, strength) {
      var k = strength || 1;
      var o = c.createOscillator(); o.type = "sine";
      o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      var g = env(c, t, 0.9 * k, 0.004, 0.3); o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.36);
      var n = noise(c, 0.2), f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900;
      var gn = env(c, t, 0.5 * k, 0.002, 0.12); n.connect(f).connect(gn).connect(c.destination); n.start(t); n.stop(t + 0.2);
    }
    function brass(c, t, freq, dur, vol, bend) {
      var o = c.createOscillator(); o.type = "sawtooth";
      o.frequency.setValueAtTime(freq, t);
      if (bend) o.frequency.linearRampToValueAtTime(freq * bend, t + dur);
      var vib = c.createOscillator(), vg = c.createGain(); vib.frequency.value = 5.5; vg.gain.value = freq * 0.018;
      vib.connect(vg).connect(o.frequency);
      var f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(1500, t + dur * 0.3); f.Q.value = 2;
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.04);
      g.gain.setValueAtTime(vol, t + dur * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(f).connect(g).connect(c.destination);
      vib.start(t); o.start(t); o.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
    }
    function bell(c, t, freq, dur, vol) {
      var o = c.createOscillator(); o.type = "triangle"; o.frequency.value = freq;
      var g = env(c, t, vol, 0.01, dur); o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
    }
    var SOUNDS = {
      "desk-reject": function (c, t) {
        thud(c, t, 1); thud(c, t + 0.28, 1.15);
        [233, 220, 208, 196].forEach(function (f, i) { brass(c, t + 0.75 + i * 0.42, f, i === 3 ? 1.1 : 0.38, 0.2, i === 3 ? 0.94 : 0); });
      },
      reject: function (c, t) {
        thud(c, t, 1);
        [294, 277, 262, 247].forEach(function (f, i) { brass(c, t + 0.45 + i * 0.4, f, i === 3 ? 1.0 : 0.36, 0.18, i === 3 ? 0.95 : 0); });
      },
      "major-revision": function (c, t) {
        thud(c, t, 0.9);
        brass(c, t + 0.4, 131, 0.22, 0.2); brass(c, t + 0.7, 131, 0.22, 0.2); brass(c, t + 1.0, 123, 1.2, 0.22, 0.97);
      },
      "minor-revision": function (c, t) {
        thud(c, t, 0.6);
        [523, 659, 784].forEach(function (f, i) { bell(c, t + 0.3 + i * 0.12, f, 0.5, 0.25); });
        bell(c, t + 0.68, 1047, 0.9, 0.25);
      },
      accept: function (c, t) {
        thud(c, t, 0.6);
        [523, 659, 784, 1047].forEach(function (f, i) { bell(c, t + 0.28 + i * 0.1, f, 0.45, 0.22); });
        [523, 659, 784, 1047].forEach(function (f) { bell(c, t + 0.75, f, 1.3, 0.13); });
        brass(c, t + 0.75, 523, 1.1, 0.09);
      }
    };
    function sound(key) {
      var c = ac();
      if (!c || !SOUNDS[key]) return;
      SOUNDS[key](c, c.currentTime + 0.12);
    }

    function confetti(host) {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      var cv = document.createElement("canvas");
      cv.className = "fx-confetti";
      host.appendChild(cv);
      var dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      var g = cv.getContext("2d"); g.scale(dpr, dpr);
      var colors = ["#c8323f", "#1d4fa0", "#ffb43d", "#2e9e6b", "#8a4fd0", "#f2f2f2"];
      var bits = [];
      for (var i = 0; i < 170; i++) {
        var left = i % 2 === 0;
        bits.push({ x: left ? -10 : W + 10, y: H * (0.55 + Math.random() * 0.35),
          vx: (left ? 1 : -1) * (4 + Math.random() * 9), vy: -(8 + Math.random() * 11),
          w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
          c: colors[i % colors.length] });
      }
      var t0 = performance.now();
      (function frame(now) {
        var t = (now - t0) / 1000;
        g.clearRect(0, 0, W, H);
        bits.forEach(function (b) {
          b.vy += 0.32; b.vx *= 0.992; b.x += b.vx; b.y += b.vy; b.r += b.vr;
          g.save(); g.translate(b.x, b.y); g.rotate(b.r); g.fillStyle = b.c;
          g.globalAlpha = Math.max(0, Math.min(1, 3.2 - t));
          g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.r * 2)) + 1);
          g.restore();
        });
        if (t < 3.3) requestAnimationFrame(frame); else cv.remove();
      })(t0);
    }

    // The overlay lives inside the open dialog, so it is drawn above it.
    function decision(label, host) {
      var key = label.toLowerCase().replace(/\s+/g, "-");
      var happy = key === "accept" || key === "minor-revision";
      var over = document.createElement("div");
      over.className = "fx-overlay";
      over.setAttribute("aria-hidden", "true");
      var st = document.createElement("div");
      st.className = "fx-stamp " + (happy ? "fx-happy" : "fx-sad");
      st.textContent = label;
      over.appendChild(st);
      (host || document.body).appendChild(over);
      var gone = false;
      function end() { if (gone) return; gone = true; over.classList.add("fx-out"); setTimeout(function () { over.remove(); }, 350); }
      over.addEventListener("click", end);
      sound(key);
      if (happy) setTimeout(function () { confetti(over); }, 260);
      setTimeout(end, happy ? 2600 : 1900);
    }

    return { decision: decision, preview: function () { sound("accept"); } };
  })();

  // ------------------------------------------------------------ response to the referee
  // A random, sarcastic reply for each comment; the pools follow the comment's type.

  // ------------------------------------------------------------ the referee report
  // The decision letter is written as a report in Reviewer 2's own voice:
  // the comments of the round, each once (with how often it was made), from
  // the minor ones to the reasons for rejection, joined into prose.

  var Report = (function () {
    var ORDER = ["comment", "revise", "reject"];
    var OPENINGS = [
      "The paper addresses a question. I have read it, or at least enough of it to form an opinion, and my opinion follows, in increasing order of severity.",
      "I was asked to review this manuscript and, against my better judgement, I did. My comments are below, from the merely irritating to the fatal.",
      "The authors have clearly worked hard on this paper. Unfortunately, effort is not identification. I list my concerns from the least to the most serious.",
      "This is a paper. Beyond that, I have some reservations, which I set out below, starting with the small ones so that the authors can warm up."
    ];
    var SECTIONS = {
      comment: { title: "Minor comments", intro: [
        "Let me begin with the small things.",
        "Before the serious problems, a few minor remarks.",
        "Some smaller issues first."],
        // where the reader was when the thought came: one per comment, never repeated
        where: [
          "On the first page, I wondered:", "Reading the introduction, I asked myself:", "In the margin of page 3, I wrote:",
          "A small note to self, early on:", "Glancing at the figures, I thought:", "Somewhere in the literature review, I jotted down:",
          "Before even reaching the data, I noted:", "By the end of the introduction, one question remained:", "In the abstract already, I scribbled:"] },
      revise: { title: "Major concerns", intro: [
        "My main concerns are about the empirical strategy.",
        "The analysis raises several serious concerns.",
        "I now turn to the substance, such as it is."],
        where: [
          "Reaching the empirical section, I noted:", "Looking at Table 2, my first reaction was:", "Turning to identification, I wrote in the margin:",
          "By the robustness section, the thought was:", "Here I stopped reading for a moment:", "Staring at the main specification, I could only think:",
          "Next to the event-study figure, I wrote:", "Somewhere around equation (4), I sighed:", "Flipping to the appendix for reassurance, I found instead:"] },
      reject: { title: "Fundamental problems", intro: [
        "More fundamentally, the paper has problems that no revision can fix.",
        "Finally, and most importantly.",
        "I come now to the reasons why this paper cannot be published, here or anywhere."],
        where: [
          "By page ten, my verdict was forming:", "It was here that I wrote, in capitals:", "Putting the paper down for coffee, I thought:",
          "Picking it up again, I could only add:", "In red ink, underlined:", "On the last page I read, I concluded:",
          "Halfway through, I was already sure:", "At this point I reached for the stamp:", "My final note, written with some force:"] }
    };
    var THEN = ["A little later:", "Then:", "Shortly after:", "Further on:", "Next to a footnote:", "Turning the page:"];
    // a thought that came back while reading ({n}: twice, three times, ...)
    var REPEATS = [
      "The thought came back {n} as I read on.",
      "I wrote this in the margin {n}, in increasingly large letters.",
      "It crossed my mind {n}, each time with more conviction.",
      "I underlined it {n}.",
      "By the end, this note appeared {n} in the margins.",
      "The thought would not go away; it came back {n}.",
      "I returned to this {n}, and each time it was worse.",
      "I found myself thinking it {n}, which says something.",
      "This occurred to me {n}, on pages I would rather forget."
    ];
    var CLOSINGS = [
      "I hope these comments will be useful to the authors, in this or in another career.",
      "I wish the authors the best of luck with this paper, which they will need.",
      "I look forward to reading the next version, or rather to being asked to."
    ];

    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function lowerFirst(t) { return /^(I\b|I'|[A-Z]{2})/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1); }
    function sentence(t) { return /[.!?]$/.test(t) ? t : t + "."; }

    // log -> [{ title, text }] paragraphs, plus an opening and a closing
    function build(log) {
      var seen = {}, list = [];
      log.forEach(function (e) {
        var k = e.text.trim().toLowerCase();
        if (seen[k]) { seen[k].n += 1; return; }
        seen[k] = { text: e.text.trim(), severity: ORDER.indexOf(e.severity) >= 0 ? e.severity : "comment", n: 1 };
        list.push(seen[k]);
      });
      var out = { opening: pick(OPENINGS), sections: [], closing: pick(CLOSINGS) };
      var repeats = [];  // each repetition line once per report, as long as there are new ones
      function repeatLine(n) {
        if (!repeats.length) repeats = REPEATS.slice();
        var line = repeats.splice(Math.floor(Math.random() * repeats.length), 1)[0];
        var words = ["", "once", "twice", "three times", "four times", "five times", "six times", "seven times", "eight times", "nine times", "ten times"];
        return line.replace("{n}", words[n] || n + " times");
      }
      ORDER.forEach(function (sev) {
        var items = list.filter(function (c) { return c.severity === sev; });
        if (!items.length) return;
        var where = SECTIONS[sev].where.slice(), then = THEN.slice();
        var parts = [pick(SECTIONS[sev].intro)];
        items.forEach(function (c) {
          var pool = where.length ? where : then.length ? then : (then = THEN.slice());
          var lead = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
          var s = lead + " \u201C" + c.text.replace(/\s+$/, "") + "\u201D";
          if (!/[.!?]$/.test(c.text.trim())) s += ".";
          if (c.n > 1) s += " " + repeatLine(c.n);
          parts.push(s);
        });
        out.sections.push({ title: SECTIONS[sev].title, text: parts.join(" "), severity: sev });
      });
      return out;
    }
    // the same list, for the report dialog: each comment once, minor to red, with counts
    function unique(log) {
      var items = [], seen = {};
      log.forEach(function (e) {
        var k = e.text.trim().toLowerCase();
        if (seen[k]) { seen[k].n++; return; }
        seen[k] = { text: e.text, severity: e.severity, n: 1 }; items.push(seen[k]);
      });
      return items.sort(function (a, c) { return ORDER.indexOf(a.severity) - ORDER.indexOf(c.severity); });
    }
    return { build: build, unique: unique };
  })();

  var Responses = (function () {
    // The authors' reply, written as one letter: an opening, one paragraph for
    // each theme the referee touched (quoting the comments), a comparison or
    // two, and a closing that follows the decision. Every line is drawn at
    // random, so no two letters are the same.

    var THEMES = [
      { key: "identification", re: /endogene|causa|parallel trend|first stage|instrument|placebo|fixed effect|fishing|identif|pre-?trend|callaway|sant'anna|diff-in-diff|exogen/i,
        lead: [
          "On identification, the referee writes: {q}.",
          "The referee's main concern is identification: {q}.",
          "Turning to the empirical strategy, the referee objects: {q}."
        ],
        body: [
          "We have now instrumented the instrument, controlled for the controls and clustered the clusters. The coefficient survives, as coefficients tend to do when the authors are motivated.",
          "Following the referee, we re-estimated everything with every estimator published since 2018. All of them agree, except the one the referee prefers, which we have moved to a footnote out of respect.",
          "We note that the referee raises endogeneity in the same tone other people use to say “bless you”: by reflex, and without waiting for an answer.",
          "Parallel trends hold. We checked them in levels, in logs and, at the referee's implicit request, in a mirror.",
          "We appreciate the reminder that correlation is not causation. We would add that a referee report is not a review."
        ] },
      { key: "contribution", re: /care|contribution|interest|question|what we learn|audience|footnote|nobody asked|marginal|overpromis|field journal|different field|well known|surpris|descriptive|is this economics/i,
        lead: [
          "The referee questions the contribution of the paper: {q}.",
          "On the motivation, the referee asks: {q}.",
          "The referee is not persuaded that the paper matters: {q}."
        ],
        body: [
          "The question of why anyone should care has troubled philosophers for millennia. We are flattered that the referee expects us to settle it in the introduction, and we have tried.",
          "The contribution is now stated three times on page one, in bold, and once more in the conclusion for readers who start from the end, as the referee evidently did.",
          "We agree that the paper answers a question nobody asked. So, in fairness, did the referee's report.",
          "We have added a paragraph explaining why this is economics. It is two pages long and cites Adam Smith, which we expect will settle the matter."
        ] },
      { key: "literature", re: /cite|literature|my student|well known|unaware|known result|already been done/i,
        lead: [
          "The referee points us to the literature: {q}.",
          "On related work, the referee notes: {q}."
        ],
        body: [
          "We now cite the referee's work four times, including the working paper that does not exist yet but surely will.",
          "We were unable to locate the referee's student's 2014 paper, but we have cited it anyway, as is customary.",
          "The literature review has grown from one page to six. It is now the most rigorous part of the report, ours included."
        ] },
      { key: "statistics", re: /standard error|significan|robust|sample|p-hack|statistic|specification|clustered|power|machine learning/i,
        lead: [
          "On the statistics, the referee observes: {q}.",
          "The referee is worried about inference: {q}."
        ],
        body: [
          "The appendix now reports 1,024 specifications. The result holds in 1,023 of them; the remaining one is the referee's favourite, and it does not converge.",
          "Our standard errors are now clustered at the level of the individual, the household, the municipality and the referee's mood.",
          "We have added the requested robustness check, and then another one, just in case the referee changes their mind between rounds."
        ] },
      { key: "presentation", re: /figure|abstract|appendix|theory section|decorative|writing|clarity|title/i,
        lead: [
          "On the presentation, the referee remarks: {q}.",
          "The referee comments on the exposition: {q}."
        ],
        body: [
          "We have rewritten the abstract so that it promises less. It now promises nothing, which we understand to be the referee's standard.",
          "The theory section is no longer decorative: it is now load-bearing, and we have asked a structural engineer to sign it off.",
          "The figures remain beautiful. We decided that one beautiful thing per report was not too much to ask."
        ] },
      { key: "verdict", re: /reject|desk|not convinced|resubmit|why should|not of general/i,
        lead: [
          "Finally, the referee concludes: {q}.",
          "The referee's verdict is unambiguous: {q}."
        ],
        body: [
          "We respect the referee's conviction, which seems to have been reached well before the paper was opened.",
          "We are grateful for the clarity. Few people manage to be wrong so concisely.",
          "We have taken the verdict to heart, and the paper to a better journal."
        ] }
    ];

    var OPENINGS = [
      "We thank Reviewer 2 for the report, which we have read twice: once to understand it, and once to make sure there was nothing to understand.",
      "We are grateful to Reviewer 2 for the time devoted to our manuscript. Judging from the report, it was about four minutes, and we appreciate every one of them.",
      "We thank the referee for a report that is short, confident and, in places, about our paper.",
      "We were delighted to receive Reviewer 2's comments, which have improved the paper in ways the referee will not notice, since the referee will not read it again.",
      "Reviewer 2 raises several points. We address each of them below, in the order in which they were shouted."
    ];

    // Comparisons: most are general; the topical ones (one subject, taken
    // seriously) come up in about one letter in five, never more than one.
    var COMPARISONS = [
      "Reading this report was less productive than explaining democracy to a fascist.",
      "Reading this report was about as rewarding as explaining parallel trends to a flat-earther.",
      "We have learned more from arguing with a parking meter.",
      "After this report, we doubt the referee could review a Mickey Mouse comic without asking for an instrument.",
      "Engaging with these comments felt like running a country on a horoscope: confident, detailed, and unrelated to the evidence.",
      "We have had more constructive exchanges with the airport self-check-in machine.",
      "Taking this report seriously would be like letting the man who believes in a strong leader explain checks and balances.",
      "The report has the internal consistency of a conspiracy theory and roughly the same relationship with the data.",
      "We read the report as one reads a horoscope: carefully, and without changing anything.",
      "This was the most confident set of claims we have seen since a politician promised to make the trains run on time.",
      "Reading this report was like asking a cat for directions: the answer came quickly and with total conviction, and it was wrong.",
      "The report has the depth of a puddle and the self-confidence of an ocean.",
      "We have received more careful feedback from a fortune cookie, and the fortune cookie at least came with a snack.",
      "The referee engages with the paper the way a tourist engages with a cathedral: a photograph of the entrance, and off to lunch.",
      "This report is to peer review what instant coffee is to coffee.",
      "Reading these comments was like watching someone review a restaurant from the car park.",
      "The referee's confidence is inversely proportional to the number of pages read, which our estimates put at two.",
      "We have seen more rigorous identification strategies in a horoscope column, and the horoscope had a control group: the other eleven signs.",
      "The report would make an excellent placebo: it has no effect, and everyone can tell.",
      "We are told that a monkey at a typewriter will eventually write Shakespeare. We now know what the earlier drafts look like.",
      "Reading this report felt like a seminar question that begins with \u201CThis is more of a comment than a question\u201D and lasts for four pages.",
      "The referee has the rare gift of being wrong with footnotes.",
      "We admire a report that manages to be both vague and rude, a combination usually reserved for airline customer service.",
      "We have had more productive conversations with a printer that was out of toner.",
      "If confidence were a contribution, this report would be in a top-five journal.",
      "This is the first report we have read that would fail its own robustness checks.",
      "The referee's comments have the statistical power of a sample of one, which, on reflection, they are."
    ];
    var TOPICAL = [
      "The report is about as respectful of the evidence as a settlement is of international law.",
      "Asked to engage with our main result, the referee replied by asking us to define \u201Ceffect\u201D. We recognise the technique: when the evidence is unbearable, ask for a definition.",
      "The report dismisses our estimates the way some governments dismiss UN findings: unread, and with total confidence.",
      "Reviewer 2 treats our results the way some governments treat satellite images: as a matter of opinion.",
      "The referee disputes our numbers with a familiar method: first keep out the journalists who could count, then call the count unverified.",
      "The referee's standard of proof is the one usually reserved for war crimes: impossible to meet, by design.",
      "Every point we made was met with \u201Cit's complicated\u201D, a phrase we have learned to recognise from people who know exactly how simple it is."
    ];
    var TOPICAL_SHARE = 0.2;

    var CLOSINGS = {
      bad: [
        "In light of the above, we have decided to submit the paper elsewhere, where we hope it will be read by someone who has read it.",
        "We accept the decision with the serenity of authors who have seen worse, and the quiet satisfaction of knowing that, one day, the referee's own paper will land on our desk.",
        "We thank the editor for the opportunity to learn, once again, that peer review is a random variable with a fat left tail."
      ],
      revise: [
        "We hope that the revised version, now 40 pages longer, meets the referee's expectations, or at least exhausts them.",
        "We look forward to the next round, and to the new concerns the referee will have about the parts that did not change."
      ],
      good: [
        "We are moved by the referee's acceptance, which we attribute to fatigue, and we will not question it.",
        "We thank the referee for being, on this occasion, Reviewer 1."
      ]
    };

    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    // Replies to specific comments (the preset ones and their usual variants);
    // a comment with no specific reply gets a generic line for its theme.
    var SPECIFIC = [
      [/machine learning/i, ["We tried machine learning, as suggested. The machine learned that the referee was wrong, and we report its findings in the appendix."]],
      [/why should i care/i, ["Why anyone should care is a question that has troubled philosophers for millennia; we are flattered that the referee expects us to settle it in the introduction, and we have tried."]],
      [/is this economics/i, ["We have added a paragraph explaining why this is economics. It is two pages long and cites Adam Smith, which we expect will settle the matter."]],
      [/what is the contribution/i, ["The contribution is now stated three times on page one, in bold, and once more in the conclusion for readers who start from the end, as the referee evidently did."]],
      [/cite my paper/i, ["We now cite the referee's work four times, including the working paper that does not exist yet but surely will."]],
      [/^endogeneity/i, ["We note that the referee raises endogeneity the way other people say \u201Cbless you\u201D: by reflex, and without waiting for an answer."]],
      [/correlation is not causation/i, ["We appreciate the reminder that correlation is not causation, and we would add that a referee report is not a review."]],
      [/parallel trends/i, ["Parallel trends hold: we checked them in levels, in logs and, at the referee's implicit request, in a mirror."]],
      [/callaway/i, ["We re-estimated everything with every estimator published since 2018. All of them agree, except the one the referee prefers, which we have moved to a footnote out of respect."]],
      [/first stage/i, ["The first stage is now stronger, thanks to a more motivated research assistant."]],
      [/robustness check/i, ["We have added the requested robustness check, and then another one, in case the referee changes their mind between rounds."]],
      [/my student/i, ["We could not find the referee's student's 2014 paper, but we have cited it anyway, as is customary."]],
      [/economically irrelevant/i, ["We have converted the coefficient into euros, dollars and cups of coffee. In cups of coffee it is enormous."]],
      [/finish the abstract/i, ["We have shortened the abstract to two lines, in the hope that the referee reaches the end this time."]],
      [/general interest/i, ["The paper is of general interest: both our mothers have read it."]],
      [/field journal/i, ["We agree that it would suit a field journal; unfortunately, the field journals agree with the referee about us."]],
      [/desk reject/i, ["We respect the referee's conviction, which seems to have been reached well before the paper was opened."]],
      [/nobody asked/i, ["We agree that the paper answers a question nobody asked. So, in fairness, did the referee's report."]],
      [/marginal/i, ["We have made the contribution less marginal by moving it to the centre of the page."]],
      [/standard errors/i, ["Our standard errors are now clustered at the level of the individual, the household, the municipality and the referee's mood."]],
      [/p-hacking/i, ["We deny any p-hacking. We did try 1,024 specifications, and we report the best one with the pride of honest people."]],
      [/placebo/i, ["The placebo is significant because the placebo, too, responds to incentives."]],
      [/not convinced/i, ["We understand that the referee cannot be convinced, so we have written this reply for the editor."]],
      [/figures are beautiful/i, ["The figures remain beautiful: one beautiful thing per paper did not seem too much to ask."]],
      [/keep the appendix/i, ["We followed this suggestion: the appendix is now the paper, and the paper is now the appendix."]],
      [/fishing expedition/i, ["It was indeed a fishing expedition, and we are pleased to report that we caught something."]],
      [/overpromises/i, ["We have rewritten the abstract so that it promises less. It now promises nothing, which we understand to be the referee's standard."]],
      [/pity about the question/i, ["We have changed the question. The data kindly agreed to stay."]],
      [/footnote/i, ["We tried to turn the paper into a footnote, but the footnote asked for its own appendix."]],
      [/prove anything/i, ["With this sample one can indeed prove anything, which is why we were careful to prove only one thing."]],
      [/decorative/i, ["The theory section is no longer decorative: it is now load-bearing, and a structural engineer has signed it off."]],
      [/different field/i, ["We did consider moving to a different field. Unfortunately, this referee reviews for their journals too."]],
      [/do not resubmit/i, ["We will not resubmit. We will submit, which is different."]],
      [/however/i, ["We thank the referee for the \u201Cinteresting\u201D, and we have learned to fear the \u201Chowever\u201D."]],
      [/what we learn/i, ["What we learn is now stated in a box at the top of page 1, with an arrow pointing at it."]],
      [/well known/i, ["If the result is well known, we would be grateful for the reference, which the referee forgot to include."]],
      [/audience/i, ["The audience for this paper is now explicitly stated: it is the referee."]],
      [/unaware of the literature/i, ["The literature review has grown from one page to six, and is now the most rigorous part of the exchange, the report included."]],
      [/not surprising/i, ["We are sorry the result did not surprise the referee. We were surprised that it did not."]],
      [/descriptive/i, ["We take \u201Cdescriptive\u201D as a compliment: at least the referee agrees that we described something."]]
    ];
    function specific(text) {
      for (var i = 0; i < SPECIFIC.length; i++) if (SPECIFIC[i][0].test(text)) return pick(SPECIFIC[i][1]);
      return null;
    }

    // a comparison that stands on its own gets a short lead-in
    var LEADINS = ["In all honesty,", "To put things in perspective,", "We will be frank:", "If we may,"];
    function standalone(c) {
      // a lead-in only where it reads well ("If we may, reading this report…")
      return /^(Reading|Taking|Engaging|This was|This is|We have|We read|We admire)/.test(c) ? pick(LEADINS) + " " + c.charAt(0).toLowerCase() + c.slice(1) : c;
    }

    function pickN(a, n) {
      var c = a.slice(), out = [];
      while (c.length && out.length < n) out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
      return out;
    }
    function quote(texts) {
      var q = texts.slice(0, 2).map(function (t) { return "“" + t.replace(/[.!?]+$/, "") + "”"; });
      return q.length > 1 ? q[0] + " and, later, " + q[1] : q[0];
    }

    // log: the comments played; decision: the label from decide()
    function letter(log, decision) {
      var groups = {}, order = [];
      log.forEach(function (e) {
        var th = THEMES.filter(function (t) { return t.re.test(e.text); })[0];
        var k = th ? th.key : null;
        if (!k) return;
        if (!groups[k]) { groups[k] = []; order.push(k); }
        if (groups[k].indexOf(e.text) < 0) groups[k].push(e.text);
      });
      // the themes most insisted upon first, the verdict always last; at most four
      var keys = order.filter(function (k) { return k !== "verdict"; })
        .sort(function (a, b) { return groups[b].length - groups[a].length; }).slice(0, groups.verdict ? 3 : 4);
      if (groups.verdict) keys.push("verdict");

      var paras = [pick(OPENINGS)];
      var cmp = pickN(COMPARISONS, log.length > 6 ? 2 : 1);
      if (Math.random() < TOPICAL_SHARE) cmp[cmp.length - 1] = pick(TOPICAL); // one topical line at most
      keys.forEach(function (k, i) {
        var th = THEMES.filter(function (t) { return t.key === k; })[0];
        var quoted = groups[k].slice(0, 2);
        var replies = quoted.map(specific).filter(Boolean);
        if (replies.length < 2) replies = replies.concat(pickN(th.body.filter(function (b) { return replies.indexOf(b) < 0; }), 2 - replies.length));
        var p = pick(th.lead).replace("{q}", quote(quoted)) + " " + replies.join(" ");
        if (i === 1 && cmp.length) p += " " + cmp.shift(); // a comparison inside the argument
        paras.push(p);
      });
      if (!keys.length) paras.push("The referee's comments resist classification, and indeed comprehension. We have nonetheless addressed all of them.");
      cmp.forEach(function (c) { paras.push(standalone(c)); });
      var tone = /reject/i.test(decision) ? "bad" : /major/i.test(decision) ? "revise" : /accept|minor/i.test(decision) ? "good" : "revise";
      paras.push(pick(CLOSINGS[tone]));
      return paras;
    }
    return { letter: letter };
  })();

  // ------------------------------------------------------------ statistics
  // Kept apart from the board, so importing, sharing or resetting a board
  // does not touch them.

  var Stats = (function () {
    var KEY = "desk-reject:stats";
    var st = load();
    function load() {
      try {
        var raw = JSON.parse(localStorage.getItem(KEY)) || {};
        return {
          since: typeof raw.since === "string" ? raw.since : new Date().toISOString(),
          played: Math.max(0, parseInt(raw.played, 10) || 0),
          counts: raw.counts && typeof raw.counts === "object" ? raw.counts : {},
          rounds: raw.rounds && typeof raw.rounds === "object" ? raw.rounds : {}
        };
      } catch (e) { return { since: new Date().toISOString(), played: 0, counts: {}, rounds: {} }; }
    }
    function persist() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }
    function record(c, session) {
      st.played += 1;
      var t = c.text.slice(0, 140);
      st.counts[t] = (st.counts[t] || 0) + 1;
      var keys = Object.keys(st.counts);
      if (keys.length > 600) { keys.sort(function (a, b) { return st.counts[a] - st.counts[b]; }).slice(0, keys.length - 600).forEach(function (k) { delete st.counts[k]; }); }
      var log = session.log;
      st.rounds[session.ms + "#" + session.round] = {
        ms: session.ms, round: session.round, title: session.title || "",
        n: log.length, rejects: log.filter(function (e) { return e.severity === "reject"; }).length,
        decision: decide(log).label, t: new Date().toISOString()
      };
      var rk = Object.keys(st.rounds);
      if (rk.length > 400) rk.slice(0, rk.length - 400).forEach(function (k) { delete st.rounds[k]; });
      persist();
    }
    function reset() { st = { since: new Date().toISOString(), played: 0, counts: {}, rounds: {} }; persist(); }
    function row(label, value) {
      var dt = document.createElement("dt"); dt.textContent = label;
      var dd = document.createElement("dd"); dd.textContent = value;
      return [dt, dd];
    }
    function render() {
      var box = $("stats-body");
      box.replaceChildren();
      var rounds = Object.keys(st.rounds).map(function (k) { return st.rounds[k]; }).filter(function (r) { return r.n > 0; });
      if (!st.played) {
        var p = document.createElement("p"); p.className = "note"; p.textContent = "Nothing yet. Play some pads and Reviewer 2 starts keeping score.";
        box.appendChild(p); return;
      }
      var mss = new Set(rounds.map(function (r) { return r.ms; }));
      var dec = {};
      rounds.forEach(function (r) { dec[r.decision] = (dec[r.decision] || 0) + 1; });
      var order = ["Accept", "Minor revision", "Major revision", "Reject", "Desk reject"];
      var dl = document.createElement("dl");
      dl.className = "stats-list";
      [].concat(
        row("Comments played", String(st.played)),
        row("Manuscripts", mss.size + " (" + rounds.length + " round" + (rounds.length === 1 ? "" : "s") + ")"),
        row("Decisions", order.filter(function (k) { return dec[k]; }).map(function (k) { return k + " " + dec[k]; }).join(" · ") || "none yet"),
        row("Acceptance rate", rounds.length ? Math.round(100 * (dec.Accept || 0) / rounds.length) + "%" : "n/a")
      ).forEach(function (el) { dl.appendChild(el); });
      var worst = rounds.slice().sort(function (a, b) { return b.rejects - a.rejects || b.n - a.n; })[0];
      if (worst && worst.rejects) {
        row("Most battered paper", (worst.title ? "“" + worst.title + "”, " : "") + worst.ms + ", round " + worst.round + ": " + worst.rejects + " reject comment" + (worst.rejects > 1 ? "s" : "")).forEach(function (el) { dl.appendChild(el); });
      }
      box.appendChild(dl);
      var top = Object.keys(st.counts).sort(function (a, b) { return st.counts[b] - st.counts[a]; }).slice(0, 5);
      if (top.length) {
        var h = document.createElement("p"); h.className = "stats-sub"; h.textContent = "Favourite comments";
        var ol = document.createElement("ol"); ol.className = "stats-top";
        top.forEach(function (t) {
          var li = document.createElement("li");
          var span = document.createElement("span"); span.textContent = t;
          var b = document.createElement("b"); b.textContent = "× " + st.counts[t];
          li.append(span, b); ol.appendChild(li);
        });
        box.append(h, ol);
      }
      var since = document.createElement("p"); since.className = "note";
      since.textContent = "Since " + new Date(st.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + ". Kept on this device only.";
      box.appendChild(since);
    }
    return { record: record, render: render, reset: reset };
  })();

  // ------------------------------------------------------------ share link
  // A board travels in the address itself (#board=…): texts, types and banks,
  // compressed. Recordings are too large for a link and stay with the file export.

  var SEV_CODE = ["comment", "revise", "reject"];

  function b64url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64url(s) {
    var bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pipe(bytes, stream) {
    return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function encodeBoard() {
    var index = {};
    state.comments.forEach(function (c, i) { index[c.id] = i; });
    var payload = {
      f: "dr", v: 1, n: state.name, l: state.lang,
      c: state.comments.map(function (c) { return [c.text, SEV_CODE.indexOf(c.severity), c.random ? 1 : 0]; }),
      b: {}, bn: state.bankNames || {}, nb: banksIn().length
    };
    banksIn().forEach(function (n) {
      if (bankUsed(n)) payload.b[n] = state.banks[n].map(function (id) { return id ? index[id] : -1; });
    });
    var json = new TextEncoder().encode(JSON.stringify(payload));
    if (typeof CompressionStream === "function") {
      return pipe(json, new CompressionStream("deflate-raw")).then(function (z) { return "z." + b64url(z); });
    }
    return Promise.resolve("j." + b64url(json));
  }

  function decodeBoard(code) {
    var kind = code.slice(0, 2), data = unb64url(code.slice(2));
    var p = kind === "z." ? pipe(data, new DecompressionStream("deflate-raw")) : Promise.resolve(data);
    return p.then(function (bytes) {
      var o = JSON.parse(new TextDecoder().decode(bytes));
      if (!o || o.f !== "dr" || !Array.isArray(o.c)) throw new Error("not a board");
      var comments = o.c.map(function (c) { return { id: uid(), text: String(c[0] || ""), severity: SEV_CODE[c[1]] || "comment", random: c[2] !== 0 }; });
      var banks = {}, last = (parseInt(o.nb, 10) || 0) - 1;
      ALL_BANKS.forEach(function (n, k) { if (Array.isArray(o.b && o.b[n])) last = Math.max(last, k); });
      ALL_BANKS.slice(0, Math.max(1, last + 1)).forEach(function (n) {
        banks[n] = (Array.isArray(o.b && o.b[n]) ? o.b[n] : []).slice(0, PADS).map(function (i) { return comments[i] ? comments[i].id : null; });
      });
      return sanitizeBoard({ name: o.n, lang: o.l, comments: comments, banks: banks, bankNames: o.bn, settings: state.settings });
    });
  }

  function shareBase() {
    var webLocal = /^https?:$/.test(location.protocol) && !/^(localhost|127\.|\[::1\])/.test(location.hostname);
    return webLocal ? location.origin + location.pathname : SITE_URL;
  }

  function loadSharedBoard(b) {
    var n = b.comments.length;
    if (!window.confirm("Load the shared board “" + b.name + "” with " + n + " comments? It replaces your current board. Recordings are not part of shared boards.")) return false;
    b.session = state.session;
    b.presetRev = PRESET_REV;
    state = b;
    commit();
    toast("Loaded “" + b.name + "”.");
    return true;
  }

  function checkSharedLink() {
    var m = /[#&]board=([A-Za-z0-9._-]+)/.exec(location.hash || "");
    if (!m) return;
    var clear = function () { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ } };
    decodeBoard(m[1]).then(function (b) { loadSharedBoard(b); clear(); })
      .catch(function () { clear(); toast("This link does not contain a valid Desk Reject board."); });
  }

  function wireShare() {
    var dlg = $("share-dialog");
    $("share-btn").addEventListener("click", function () {
      $("share-link").value = "Preparing…";
      $("share-qr").replaceChildren();
      $("share-import-text").value = "";
      dlg.showModal();
      encodeBoard().then(function (code) {
        var url = shareBase() + "#board=" + code;
        $("share-link").value = url;
        var box = $("share-qr");
        if (window.qrcode && url.length <= 2300) {
          var qr = window.qrcode(0, "L");
          qr.addData(url, "Byte");
          qr.make();
          box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 4, scalable: true });
          $("share-qr-note").textContent = "Scan it with a phone camera to open the board there.";
        } else {
          $("share-qr-note").textContent = "This board is too large for a QR code: send the link instead.";
        }
      }).catch(function () { $("share-link").value = "The link could not be created in this browser."; });
    });
    $("share-copy").addEventListener("click", function () {
      var url = $("share-link").value;
      var done = function () { toast("Link copied."); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { $("share-link").select(); document.execCommand("copy"); done(); });
      else { $("share-link").select(); document.execCommand("copy"); done(); }
    });
    $("share-import").addEventListener("click", function () {
      var m = /[#&]board=([A-Za-z0-9._-]+)/.exec($("share-import-text").value.trim());
      if (!m) { toast("Paste a link that contains #board=…"); return; }
      decodeBoard(m[1]).then(function (b) { if (loadSharedBoard(b)) dlg.close(); })
        .catch(function () { toast("This link does not contain a valid Desk Reject board."); });
    });
  }

  // ------------------------------------------------------- update banner
  // Desktop app: a small card in the corner while an update downloads.

  // ------------------------------------------------------------ what's new
  // A guided tour shown once after an update (see assets/whatsnew.js): a
  // spotlight on the element, a card with Back / Next / Skip. Any other key
  // or a pad press closes it, so it never gets in the way of a seminar.

  var Tour = (function () {
    var DATA = window.DESK_REJECT_WHATSNEW || { welcome: [], releases: [] };
    var SEEN_KEY = "desk-reject:seen-version";
    var MAX_STEPS = 7;
    var desktop = !!(window.deskReject && window.deskReject.desktop);
    var latest = (DATA.releases[0] || {}).version || "0";
    var steps = [], i = 0, root = null, spot = null, card = null;

    function cmp(a, b) { return newerThan(a, b) ? 1 : newerThan(b, a) ? -1 : 0; }
    function newerThan(a, b) {
      var pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
      for (var k = 0; k < 3; k++) { if ((pa[k] || 0) !== (pb[k] || 0)) return (pa[k] || 0) > (pb[k] || 0); }
      return false;
    }
    function fits(s) { return s.desktop === undefined || s.desktop === desktop; }
    function readSeen() { try { return localStorage.getItem(SEEN_KEY); } catch (e) { return null; } }
    function markSeen() { try { localStorage.setItem(SEEN_KEY, latest); } catch (e) { /* ignore */ } }
    // steps marked "last" go at the end; the tour stays short
    function ordered(list) {
      var main = list.filter(function (s) { return !s.last; }), tail = list.filter(function (s) { return s.last; });
      return main.slice(0, MAX_STEPS - tail.length).concat(tail);
    }
    function stepsSince(seen) {
      var out = [];
      DATA.releases.forEach(function (r) { if (cmp(r.version, seen) > 0) r.steps.filter(fits).forEach(function (s) { out.push(s); }); });
      return ordered(out);
    }

    function place() {
      if (!root) return;
      var s = steps[i];
      var el = s.target ? document.querySelector(s.target) : null;
      var r = el && el.getClientRects().length ? el.getBoundingClientRect() : null;
      var vw = window.innerWidth, vh = window.innerHeight, pad = 8;
      if (r) {
        spot.hidden = false;
        spot.style.left = (r.left - pad) + "px"; spot.style.top = (r.top - pad) + "px";
        spot.style.width = (r.width + 2 * pad) + "px"; spot.style.height = (r.height + 2 * pad) + "px";
        root.classList.remove("tour-centre");
      } else {
        spot.hidden = true;
        root.classList.add("tour-centre");
      }
      card.querySelector(".tour-step").textContent = (i + 1) + " / " + steps.length;
      card.querySelector(".tour-title").textContent = s.title;
      card.querySelector(".tour-text").textContent = s.text;
      card.querySelector(".tour-back").hidden = i === 0;
      card.querySelector(".tour-next").textContent = i === steps.length - 1 ? "Done" : "Next";
      // the card goes below the target if there is room, otherwise above, otherwise centred
      var cw = Math.min(360, vw - 32), ch = card.offsetHeight || 170, left, top;
      card.style.width = cw + "px";
      if (r) {
        left = Math.max(16, Math.min(vw - cw - 16, r.left + r.width / 2 - cw / 2));
        if (r.bottom + pad + 14 + ch < vh - 12) top = r.bottom + pad + 14;
        else if (r.top - pad - 14 - ch > 12) top = r.top - pad - 14 - ch;
        else { top = (vh - ch) / 2; left = (vw - cw) / 2; }
      } else { top = (vh - ch) / 2; left = (vw - cw) / 2; }
      card.style.left = left + "px"; card.style.top = top + "px";
      card.querySelector(".tour-next").focus({ preventScroll: true });
    }

    function onKey(e) {
      if (!root) return;
      if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); go(-1); }
      else if (e.key === "Tab" || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) { /* stay */ }
      else close(); // Esc, or a pad key during a seminar: the tour gives way
    }
    function go(d) {
      if (i + d >= steps.length) { close(); return; }
      i = Math.max(0, i + d);
      place();
    }
    function close() {
      if (!root) return;
      root.remove(); root = null;
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey, true);
      markSeen();
    }

    function start(list, heading) {
      steps = (list || []).filter(fits);
      if (!steps.length || root) return;
      i = 0;
      root = document.createElement("div");
      root.className = "tour";
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-label", heading);
      spot = document.createElement("div"); spot.className = "tour-spot";
      card = document.createElement("div"); card.className = "tour-card";
      card.innerHTML = '<p class="tour-kicker"><span class="tour-head"></span><span class="tour-step"></span></p>'
        + '<p class="tour-title"></p><p class="tour-text"></p>'
        + '<div class="tour-actions"><button type="button" class="text-btn tour-skip">Skip tour</button><span class="spacer"></span>'
        + '<button type="button" class="text-btn tour-back">Back</button><button type="button" class="ink-btn tour-next">Next</button></div>';
      card.querySelector(".tour-head").textContent = heading;
      card.querySelector(".tour-skip").addEventListener("click", close);
      card.querySelector(".tour-back").addEventListener("click", function () { go(-1); });
      card.querySelector(".tour-next").addEventListener("click", function () { go(1); });
      root.append(spot, card);
      document.body.appendChild(root);
      window.addEventListener("resize", place);
      document.addEventListener("keydown", onKey, true);
      place();
      requestAnimationFrame(place); // after the card has its real height
    }

    // At startup: a welcome for a new install, the news after an update, nothing otherwise.
    function auto(isNewInstall) {
      var seen = readSeen();
      if (isNewInstall) { if (!seen) start(DATA.welcome, "Welcome to Desk Reject"); markSeen(); return; }
      // boards from before the tour existed: show what came after 1.2.1
      var list = stepsSince(seen || "1.2.1");
      if (list.length) start(list, "What's new"); else markSeen();
    }
    // Help → What's New, or Settings → What's new: the latest releases again.
    function again() {
      var list = [];
      DATA.releases.forEach(function (r) { r.steps.filter(fits).forEach(function (s) { list.push(s); }); });
      start(ordered(list), "What's new");
    }
    return { auto: auto, again: again, isOpen: function () { return !!root; } };
  })();

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

  // The same actions for the keyboard and for the desktop app's global shortcuts.
  function runAction(a) {
    if (a.type === "stop") { stopAll(); return true; }
    if (a.type === "random") { playRandom(); return true; }
    if (a.type === "bank") {
      var letters = banksIn(), i = letters.indexOf(bank()) + a.step;
      if (i >= 0 && i < letters.length) { selectBank(letters[i]); return true; }
      return false;
    }
    if (a.type === "pad") {
      var c = padsOf(bank())[a.index];
      if (c) { play(c, padButton(c.id)); return true; }
    }
    return false;
  }

  function wireKeys() {
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target && e.target.tagName) || "";
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || document.querySelector("dialog[open]")) return;
      if (e.key === "Escape") { stopAll(); return; }
      if (e.key === " " && !/^(BUTTON|A)$/.test(tag)) { e.preventDefault(); playRandom(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (runAction({ type: "bank", step: e.key === "ArrowRight" ? 1 : -1 })) e.preventDefault();
        return;
      }
      var idx = PAD_CODES.indexOf(e.code);
      if (idx >= 0 && runAction({ type: "pad", index: idx })) e.preventDefault();
    });
    // Desktop app: shortcuts that work while another app (Keynote, PowerPoint…) is in front.
    var bridge = window.deskReject;
    if (bridge && bridge.onShortcut) {
      bridge.onShortcut(function (a) { runAction(a); });
      applyGlobalKeys();
    }
  }

  function applyGlobalKeys() {
    var bridge = window.deskReject;
    if (!bridge || !bridge.setGlobalShortcuts) return;
    bridge.setGlobalShortcuts(!!state.settings.globalKeys).then(function (res) {
      var note = $("global-keys-note");
      if (!note) return;
      if (!state.settings.globalKeys) { note.textContent = ""; return; }
      note.textContent = res && res.failed && res.failed.length
        ? "Some combinations are taken by another app and do not work: " + res.failed.join(", ") + "."
        : "Active: they work even while another app is in front.";
    }).catch(function () {});
  }

  // ----------------------------------------------------------------- boot

  function boot() {
    renderMasthead();
    if (presetUpgraded) save();
    if (upgradedPreset) {
      setTimeout(function () { toast(filledBankB ? "New in this version: pad bank B, with harsher comments." : "New preset comments were added to your reserve."); }, 600);
    }

    // On GitHub Pages (user.github.io/repo) point "Source code" at the repo;
    // elsewhere drop the link rather than show a dead one.
    var link = $("source-link");
    var gh = /^([\w-]+)\.github\.io$/i.exec(location.hostname);
    var repo = location.pathname.split("/").filter(Boolean)[0];
    if (window.deskReject && window.deskReject.repoURL) link.href = window.deskReject.repoURL;
    else if (gh && repo) link.href = "https://github.com/" + gh[1] + "/" + repo;
    else if (/^https?:$/.test(location.protocol) && !/^(localhost|127\.|\[::1\])/.test(location.hostname)) link.href = HOME_REPO;
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
      toast(i >= 0 ? "Added on pad " + PAD_LABELS[i] + " of pad bank " + bank() + "." : "Pad bank " + bank() + " is full, so the comment went to the reserve.");
    });

    wireEditor();
    wirePicker();
    wireSettings();
    wireReport();
    wireShare();
    wireSwipe();
    wireKeys();

    if (synth) {
      loadVoices();
      if (typeof synth.addEventListener === "function") synth.addEventListener("voiceschanged", loadVoices);
      else synth.onvoiceschanged = loadVoices;
    }

    recKeys().then(function (keys) { (keys || []).forEach(function (k) { recIds.add(k); }); render(); })
      .catch(function () { render(); });
    render();
    checkSharedLink();
    $("whats-new-btn").addEventListener("click", function () { $("settings").close(); Tour.again(); });
    if (window.deskReject && window.deskReject.onWhatsNew) window.deskReject.onWhatsNew(function () { Tour.again(); });
    setTimeout(function () { if (!document.querySelector("dialog[open]")) Tour.auto(isNewInstall); }, 1200);
    window.addEventListener("hashchange", checkSharedLink);

    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }

  boot();
})();
