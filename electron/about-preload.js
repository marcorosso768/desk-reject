/* Bridge for the About window (electron/about-window.html). */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const info = ipcRenderer.sendSync("dr:info") || {};
contextBridge.exposeInMainWorld("aboutWindow", {
  version: info.version || "",
  platform: process.platform,
  open: (url) => ipcRenderer.send("about:open", String(url))
});
