/* Update window: draws the state sent by the main process (title, message, notes, progress,
   details, buttons) and sends back the id of the button pressed. */
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.updateWindow;
  if (api.platform !== "darwin") {
    // other systems: the full-tile icons
    $("icon").src = "../assets/icons/icon-512.png";
    $("icon-dark").srcset = "../assets/icons/icon-512-dark.png";
  }

  // The window takes the height of its content, asked again whenever the layout changes
  // (new state, text wrapping), but only when the height really changes.
  var lastHeight = 0;
  function reportHeight() {
    var cs = getComputedStyle(document.body);
    var h = Math.ceil(document.querySelector(".panel").getBoundingClientRect().height + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
    if (h !== lastHeight) { lastHeight = h; api.resize(h); }
  }
  new ResizeObserver(reportHeight).observe(document.querySelector(".panel"));

  // Release notes: one block per version, newest first (text only, never HTML).
  var notesSig = "";
  function renderNotes(notes) {
    var sig = JSON.stringify(notes || []);
    if (sig === notesSig) return;            // progress updates do not reset the scroll position
    notesSig = sig;
    var box = $("notes");
    box.textContent = "";
    (notes || []).forEach(function (r) {
      var sec = document.createElement("section"); sec.className = "rel";
      var head = document.createElement("div"); head.className = "rel-head";
      var v = document.createElement("b"); v.textContent = "v" + r.version;
      var d = document.createElement("span"); d.textContent = r.date || "";
      head.append(v, d);
      var ul = document.createElement("ul");
      r.items.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
      sec.append(head, ul);
      box.appendChild(sec);
    });
    box.scrollTop = 0;
  }

  function render(s) {
    if (s.accent) document.documentElement.style.setProperty("--accent", s.accent);
    $("title").textContent = s.title || "";
    $("message").textContent = s.message || "";
    $("notes-label").textContent = s.notesLabel || "";
    renderNotes(s.notes);
    document.body.classList.toggle("has-notes", !!(s.notes && s.notes.length));
    $("check").classList.toggle("hidden", !s.checkbox);
    if (s.checkbox) { $("check-label").textContent = s.checkbox.label; $("check-box").checked = !!s.checkbox.checked; }
    $("detail").textContent = s.detail || "";
    var bar = $("bar");
    bar.classList.toggle("hidden", s.progress == null);
    bar.classList.toggle("indeterminate", s.progress === "indeterminate");
    bar.firstElementChild.style.width = typeof s.progress === "number" ? s.progress + "%" : "";
    // rebuild the buttons only when they change, so progress updates do not steal focus
    var box = $("buttons"), left = $("left-buttons");
    var sig = JSON.stringify(s.buttons || []);
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.textContent = ""; left.textContent = "";
      // macOS order: buttons marked `left` at the far left; secondary then default button on the right
      (s.buttons || []).slice().reverse().forEach(function (b) {
        var el = document.createElement("button");
        el.type = "button";
        el.textContent = b.label;
        if (b.primary) el.className = "primary";
        el.addEventListener("click", function () { api.send(b.id); });
        (b.left ? left : box).appendChild(el);
      });
      var primary = box.querySelector(".primary");
      if (primary) primary.focus();
    }
    reportHeight();
  }

  $("check-box").addEventListener("change", function (e) { api.send(e.target.checked ? "auto:on" : "auto:off"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") api.send("escape"); });
  api.onState(render);
})();
