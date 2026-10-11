/* Exposes a tiny, read-only bridge to the page: version and repository link. */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const info = ipcRenderer.sendSync("dr:info") || {};
// Lets the stylesheet adapt to the desktop window (no page margins, title bar area).
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("desktop", "desktop-" + (info.platform || "other"));
});

contextBridge.exposeInMainWorld("deskReject", {
  desktop: true,
  platform: info.platform || null,
  version: info.version || null,
  repoURL: info.repoURL || null
});
