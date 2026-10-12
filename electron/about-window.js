/* About window: version from the app; links open in the browser. */
"use strict";
(function () {
  var api = window.aboutWindow;
  document.getElementById("version").textContent = "Version " + api.version;
  if (api.platform !== "darwin") {
    document.getElementById("icon").src = "../assets/icons/icon-512.png";
    document.getElementById("icon-dark").srcset = "../assets/icons/icon-512-dark.png";
  }
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    api.open(a.href);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") window.close(); });
})();
