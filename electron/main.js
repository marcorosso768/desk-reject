/*
 * Desk Reject desktop shell (Electron).
 * The app itself is the same static web page as the GitHub Pages version;
 * this file only adds what a desktop app needs:
 *   - serves the page from app://desk-reject/ (a secure, stable origin, so
 *     localStorage, IndexedDB and the microphone behave as on https)
 *   - asks macOS for microphone access when Record is pressed
 *   - swaps the Dock / window icon when the system switches light <-> dark
 *     (on macOS 26+ the packaged app leaves this to the system, see afterPack.js)
 *   - checks GitHub Releases once at startup and offers newer versions
 */
"use strict";

const { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, protocol, session, shell, dialog, ipcMain, systemPreferences } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "app://desk-reject";
const ICONS = path.join(ROOT, "assets", "icons");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

// ------------------------------------------------------------- repository

// CI writes electron/repo.json ({"repo": "owner/name"}) before packaging;
// otherwise fall back to the "repository" field of package.json.
function repoSlug() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, "repo.json"), "utf8")).repo;
    if (/^[\w.-]+\/[\w.-]+$/.test(r)) return r;
  } catch (e) { /* not packaged by CI */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository && pkg.repository.url) || "";
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
    if (m && m[1] !== "YOUR-GITHUB-USERNAME") return m[1] + "/" + m[2];
  } catch (e) { /* ignore */ }
  return null;
}

// ------------------------------------------------------------------ icons

function iconFor(dark) {
  // macOS Dock icons keep Apple's margins; other systems use the full tile.
  const name = process.platform === "darwin"
    ? (dark ? "icon-mac-1024-dark.png" : "icon-mac-1024.png")
    : (dark ? "icon-512-dark.png" : "icon-512.png");
  return nativeImage.createFromPath(path.join(ICONS, name));
}

// On macOS 26+ a packaged build carries the Icon Composer icon (Assets.car,
// see build-scripts/afterPack.js): the system then switches light/dark itself,
// in the Dock, Finder and Launchpad, and setting the Dock icon here would
// override it. Older macOS, and `npm start`, get the switch done by hand.
function systemHandlesIcon() {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  const darwinMajor = parseInt(require("node:os").release().split(".")[0], 10);
  return darwinMajor >= 25 && fs.existsSync(path.join(process.resourcesPath, "Assets.car"));
}

function applyTheme() {
  const dark = nativeTheme.shouldUseDarkColors;
  const img = iconFor(dark);
  if (process.platform === "darwin") { if (app.dock && !img.isEmpty() && !systemHandlesIcon()) app.dock.setIcon(img); }
  else if (win && !img.isEmpty()) win.setIcon(img);
  if (win) win.setBackgroundColor(dark ? "#16181c" : "#e4e6ea");
}

// ---------------------------------------------------------------- updates

function newer(a, b) { // is version a > version b ?
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

const prefsFile = () => path.join(app.getPath("userData"), "update-prefs.json");
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch (e) { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch (e) { /* ignore */ } }

async function checkForUpdates(manual) {
  const repo = repoSlug();
  if (!repo) {
    if (manual) dialog.showMessageBox(win, { type: "info", message: "Update checks are not configured", detail: "Set the GitHub repository in package.json (\"repository\") or build the app with the release workflow." });
    return;
  }
  try {
    const res = await net.fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "Desk-Reject/" + app.getVersion() }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    const prefs = readPrefs();
    if (!newer(latest, current)) {
      if (manual) dialog.showMessageBox(win, { type: "info", message: "Desk Reject is up to date", detail: "You have version " + current + "." });
      return;
    }
    if (!manual && prefs.skip === latest) return;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      buttons: ["Download", "Later", "Skip This Version"],
      defaultId: 0,
      cancelId: 1,
      message: "Desk Reject " + latest + " is available",
      detail: "You have version " + current + ". The download page opens in your browser; install the new version over this one."
    });
    if (response === 0) shell.openExternal(rel.html_url || "https://github.com/" + repo + "/releases/latest");
    if (response === 2) writePrefs(Object.assign(prefs, { skip: latest }));
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: "warning", message: "Could not check for updates", detail: String(e.message || e) });
  }
}

// ------------------------------------------------------------------- menu

function buildMenu() {
  const mac = process.platform === "darwin";
  const check = { label: "Check for Updates…", click: () => checkForUpdates(true) };
  const repo = repoSlug();
  const template = [
    ...(mac ? [{
      label: app.name,
      submenu: [{ role: "about" }, check, { type: "separator" }, { role: "services" }, { type: "separator" },
                { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }]
    }] : [{ label: "File", submenu: [check, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
                               { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { role: "help", submenu: repo ? [{ label: "Source Code", click: () => shell.openExternal("https://github.com/" + repo) }] : [] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Desk Reject",
    // macOS: no separate title bar, the traffic lights sit on the page itself
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#16181c" : "#e4e6ea",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.once("ready-to-show", () => win.show());

  // Anything that is not the app itself opens in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN + "/")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(ORIGIN + "/index.html");
  win.on("closed", () => { win = null; });
  applyTheme();
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  // Serve the page and its assets from the app folder, refusing paths outside it.
  protocol.handle("app", (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Microphone: allowed for the app only; on macOS the system asks once.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const own = (details.requestingUrl || "").startsWith(ORIGIN + "/");
    if (permission !== "media" || !own) return callback(false);
    if (process.platform === "darwin") {
      systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
    } else callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => permission === "media" && String(origin).startsWith(ORIGIN));

  ipcMain.on("dr:info", (e) => {
    const repo = repoSlug();
    e.returnValue = { version: app.getVersion(), platform: process.platform, repoURL: repo ? "https://github.com/" + repo : null };
  });

  nativeTheme.on("updated", applyTheme);
  buildMenu();
  createWindow();
  setTimeout(() => checkForUpdates(false), 4000);

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
