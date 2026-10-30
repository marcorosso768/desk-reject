/* The update window: shows what the main process sends, and sends back the buttons. */
"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var api = window.updateWindow;
  if (api.platform !== "darwin") {
    // other systems: the full-tile icons
    $("icon").src = "../assets/icons/icon-512.png";
    $("icon-dark").srcset = "../assets/icons/icon-512-dark.png";
    document.body.classList.add(api.platform === "win32" ? "win" : "linux");
  }
  function mb(n) { return (n / 1048576).toFixed(1) + " MB"; }
  function show(id, on, text) { $(id).hidden = !on; if (on && text !== undefined) $(id).textContent = text; }
  api.onState(function (st) {
    document.body.classList.toggle("offer", !!st.offer);
    $("title").textContent = st.title || "";
    show("subtitle", !!st.subtitle, st.subtitle);
    // progress
    var indeterminate = st.progress === null || st.progress === undefined;
    $("track").classList.toggle("indeterminate", indeterminate);
    $("bar").style.width = indeterminate ? "" : Math.round(Math.max(0, Math.min(1, st.progress)) * 1000) / 10 + "%";
    $("detail").textContent = st.detail !== undefined ? st.detail
      : (st.transferred !== undefined ? mb(st.transferred) + (st.total ? " of " + mb(st.total) : "") : "");
    // release notes: one block per version, newest first
    var notes = $("notes");
    notes.replaceChildren();
    (st.notes || []).forEach(function (r) {
      var box = document.createElement("section"); box.className = "rel";
      var head = document.createElement("div"); head.className = "rel-head";
      var v = document.createElement("b"); v.textContent = "v" + r.version;
      var d = document.createElement("span"); d.textContent = r.date || "";
      head.append(v, d);
      var ul = document.createElement("ul");
      r.items.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
      box.append(head, ul);
      notes.appendChild(box);
    });
    var hasNotes = !!(st.notes && st.notes.length);
    show("notes", hasNotes);
    show("notes-label", hasNotes && !!st.notesLabel);
    show("auto-row", st.auto !== undefined);
    if (st.auto !== undefined) $("auto").checked = !!st.auto;
    // buttons
    show("tertiary", !!st.tertiary, st.tertiary);
    show("secondary", !!st.secondary, st.secondary);
    show("primary", !!st.primary, st.primary);
    show("cancel", !!st.cancel);
    if (st.primary) $("primary").focus();
  });
  $("cancel").addEventListener("click", function () { api.send("cancel"); });
  $("primary").addEventListener("click", function () { api.send("primary"); });
  $("secondary").addEventListener("click", function () { api.send("secondary"); });
  $("tertiary").addEventListener("click", function () { api.send("tertiary"); });
  $("auto").addEventListener("change", function (e) { api.send(e.target.checked ? "auto:on" : "auto:off"); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") api.send(!$("cancel").hidden ? "cancel" : "secondary");
    if (e.key === "Enter" && !$("primary").hidden && e.target.tagName !== "INPUT") api.send("primary");
  });
})();
