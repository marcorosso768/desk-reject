/* Exposes a small bridge to the page: version, repository link, global shortcuts, saving the report. */
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
  repoURL: info.repoURL || null,
  // global shortcuts (Control+Option + pad key)
  setGlobalShortcuts: (enabled) => ipcRenderer.invoke("dr:global-shortcuts", !!enabled),
  onShortcut: (cb) => { ipcRenderer.on("dr:shortcut", (_e, action) => cb(action)); },
  // referee report: the page makes the PDF, the app asks where to save it
  savePdf: (name, bytes) => ipcRenderer.invoke("dr:save-pdf", String(name || "report.pdf"), bytes)
});
