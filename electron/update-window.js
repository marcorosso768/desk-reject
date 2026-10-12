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
  api.onState(function (st) {
    $("title").textContent = st.title || "";
    var track = $("track"), bar = $("bar");
    var indeterminate = st.progress === null || st.progress === undefined;
    track.classList.toggle("indeterminate", indeterminate);
    bar.style.width = indeterminate ? "" : Math.round(Math.max(0, Math.min(1, st.progress)) * 1000) / 10 + "%";
    $("detail").textContent = st.detail !== undefined ? st.detail
      : (st.transferred !== undefined ? mb(st.transferred) + (st.total ? " of " + mb(st.total) : "") : "");
    $("cancel").hidden = !st.cancel;
    $("primary").hidden = !st.primary;
    $("secondary").hidden = !st.secondary;
    if (st.primary) $("primary").textContent = st.primary;
    if (st.secondary) $("secondary").textContent = st.secondary;
    if (st.primary) $("primary").focus();
  });
  $("cancel").addEventListener("click", function () { api.send("cancel"); });
  $("primary").addEventListener("click", function () { api.send("primary"); });
  $("secondary").addEventListener("click", function () { api.send("secondary"); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("cancel").hidden) api.send("cancel");
    if (e.key === "Enter" && !$("primary").hidden) api.send("primary");
  });
})();
