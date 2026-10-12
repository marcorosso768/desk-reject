/* Bridge for the update window (electron/update-window.html). */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("updateWindow", {
  platform: process.platform,
  onState: (cb) => ipcRenderer.on("upd:state", (_e, st) => cb(st)),
  send: (action) => ipcRenderer.send("upd:action", String(action))
});
