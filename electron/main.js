/*
 * Desk Reject desktop shell (Electron).
 * The app itself is the same static web page as the GitHub Pages version;
 * this file only adds what a desktop app needs:
 *   - serves the page from app://desk-reject/ (a secure, stable origin, so
 *     localStorage, IndexedDB and the microphone behave as on https)
 *   - asks macOS for microphone access when Record is pressed
 *   - swaps the Dock / window icon when the system switches light <-> dark
 *     (on macOS 26+ the packaged app leaves this to the system, see afterPack.js)
 *   - checks GitHub Releases once at startup and offers newer versions, with a
 *     Sparkle-style update window; on a Mac it installs them itself
 *     (mac-updater.js), elsewhere it opens the installer
 *   - a two-column About window with the credits
 *   - optional global shortcuts, so pads play while another app is in front
 *   - saves the referee report PDF through the system's Save dialog
 */
"use strict";

const { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, protocol, screen, session, shell, dialog, ipcMain, systemPreferences, globalShortcut } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const macUpdater = require("./mac-updater");

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

// The installer that fits this computer: dmg for the right Mac chip, exe on
// Windows, AppImage on Linux. A Mac with Apple Silicon running the Intel build
// under Rosetta still gets the arm64 one.
function pickAsset(assets) {
  const files = assets.filter((a) => !/\.blockmap$|\.yml$/i.test(a.name));
  if (process.platform === "darwin") {
    const arm = process.arch === "arm64" || app.runningUnderARM64Translation;
    const dmgs = files.filter((a) => /\.dmg$/i.test(a.name));
    return arm ? dmgs.find((a) => /arm64/i.test(a.name))
               : dmgs.find((a) => /x64/i.test(a.name)) || dmgs.find((a) => !/arm64/i.test(a.name));
  }
  if (process.platform === "win32") return files.find((a) => /\.exe$/i.test(a.name));
  return files.find((a) => /\.AppImage$/i.test(a.name));
}

// ---- the update window (Sparkle style): a small separate window with the
// app icon, a status line, a progress bar and Cancel; see update-window.html.

const UpdateUI = (() => {
  let uw = null, state = null, onAction = null;
  ipcMain.on("upd:action", (e, action) => {
    if (!uw || e.sender !== uw.webContents) return;
    const fn = onAction;
    if (fn) fn(action);
  });
  function open() {
    if (uw) { uw.show(); return; }
    uw = new BrowserWindow({
      ...centredBounds(size[0], size[1]), useContentSize: true,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: "Updating Desk Reject",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2a2a2c" : "#ececec",
      webPreferences: { preload: path.join(__dirname, "update-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    uw.setMenuBarVisibility(false);
    uw.webContents.on("will-navigate", (e) => e.preventDefault());
    uw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    uw.webContents.once("did-finish-load", () => { if (state) uw.webContents.send("upd:state", state); uw.show(); });
    // closing the window is the same as Cancel (or Later, once the update is ready)
    uw.on("close", () => { const fn = onAction; onAction = null; if (fn) fn("closed"); });
    uw.on("closed", () => { uw = null; });
    uw.loadURL(ORIGIN + "/electron/update-window.html");
  }
  // st: { title, detail?, progress (0-1, or null = indeterminate), transferred?, total?, cancel?, primary?, secondary? }
  let size = [600, 112];
  function set(st, handler) {
    state = st;
    if (handler !== undefined) onAction = handler;
    // the offer of a new version is taller (notes and three buttons) than the progress view
    const want = st.size || [600, 112];
    if (uw && (want[0] !== size[0] || want[1] !== size[1])) {
      const b = centredBounds(want[0], want[1]);
      uw.setContentSize(b.width, b.height);
      const [w, h] = uw.getSize(), wa = screen.getDisplayMatching(uw.getBounds()).workArea;
      uw.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
    }
    size = want;
    if (uw && !uw.webContents.isLoading()) uw.webContents.send("upd:state", st);
    if (win) {
      if (typeof st.progress === "number") win.setProgressBar(st.progress);
      else win.setProgressBar(st.busy ? 2 : -1);
    }
  }
  function close() {
    onAction = null; state = null;
    if (win) win.setProgressBar(-1);
    if (uw) { const w = uw; uw = null; w.destroy(); }
  }
  return { open, set, close, isOpen: () => !!uw };
})();

const releasesURL = (repo, rel) => (rel && rel.html_url) || "https://github.com/" + repo + "/releases";
const fmtMB = (n) => (n / 1048576).toFixed(1) + " MB";

async function upToDate(repo, current) {
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    buttons: ["OK", "Version History"],
    defaultId: 0,
    cancelId: 0,
    message: "You're up to date!",
    detail: "Desk Reject " + current + " is currently the newest version available."
  });
  if (response === 1) shell.openExternal("https://github.com/" + repo + "/releases");
}

function failed(message, detail) {
  UpdateUI.close();
  return dialog.showMessageBox(win, { type: "warning", message, detail: String(detail || "") });
}

// Windows and Linux (and a Mac that cannot replace itself): download the
// installer with the update window, then open it.
function downloadInstaller(asset, version) {
  if (!win) return;
  const ses = win.webContents.session;
  let item = null, cancelled = false;
  UpdateUI.open();
  UpdateUI.set({ title: "Downloading Desk Reject " + version + "…", progress: null, busy: true, cancel: true }, (action) => {
    if (action === "cancel" || action === "closed") { cancelled = true; if (item) item.cancel(); UpdateUI.close(); }
  });
  ses.once("will-download", (_e, it) => {
    item = it;
    if (cancelled) { item.cancel(); return; }
    const target = path.join(app.getPath("downloads"), asset.name);
    item.setSavePath(target);
    item.on("updated", () => {
      const total = item.getTotalBytes() || asset.size || 0, got = item.getReceivedBytes();
      UpdateUI.set({ title: "Downloading Desk Reject " + version + "…", progress: total ? got / total : null, busy: true,
                     detail: fmtMB(got) + (total ? " of " + fmtMB(total) : ""), cancel: true });
    });
    item.once("done", async (_e2, st) => {
      if (cancelled || st === "cancelled") return;
      UpdateUI.close();
      if (st !== "completed") {
        dialog.showMessageBox(win, { type: "warning", message: "The download did not finish", detail: "Try again with Check for Updates…, or download it from the Releases page." });
        return;
      }
      await shell.openPath(target);
      const how = process.platform === "darwin"
        ? "In the window that opened, drag Desk Reject onto Applications and choose Replace, then quit this copy and open the new one. The first time, macOS may ask again to confirm in Privacy & Security."
        : process.platform === "win32"
          ? "The installer has started: follow it, and Desk Reject reopens updated."
          : "The new AppImage is in your Downloads folder: make it executable and use it instead of this one.";
      dialog.showMessageBox(win, { type: "info", message: "Desk Reject " + version + " downloaded", detail: how });
    });
  });
  win.webContents.downloadURL(asset.browser_download_url);
}

// ---- macOS: install the update in place (see mac-updater.js)

const updatesDir = () => path.join(app.getPath("userData"), "updates");
const macArch = () => (process.arch === "arm64" || app.runningUnderARM64Translation ? "arm64" : "x64");
let pendingMacInstaller = null; // set when the user picks "Later": runs as the app quits

function canSelfInstall() {
  if (process.platform !== "darwin" || !app.isPackaged) return false; // never touch the Electron used by npm start
  return !macUpdater.selfInstallBlocker(macUpdater.currentBundlePath(process.execPath));
}

async function installMacUpdate(rel, repo, version) {
  const yml = (rel.assets || []).find((a) => a.name === "latest-mac.yml");
  const abort = new AbortController();
  let cancelled = false;
  const onCancel = (action) => {
    if (action === "cancel" || action === "closed") { cancelled = true; abort.abort(); UpdateUI.close(); }
  };
  UpdateUI.open();
  UpdateUI.set({ title: "Downloading Desk Reject " + version + "…", progress: null, busy: true, cancel: true }, onCancel);
  try {
    if (!yml) throw new Error("the release has no latest-mac.yml");
    const res = await net.fetch(yml.browser_download_url, { signal: abort.signal });
    if (!res.ok) throw new Error("latest-mac.yml: HTTP " + res.status);
    const info = macUpdater.parseLatestYml(await res.text());
    info.version = info.version || version;
    let unpacking = false;
    const launch = await macUpdater.prepareUpdate({
      fetchImpl: (u) => net.fetch(u, { signal: abort.signal }),
      repo,
      info,
      arch: macArch(),
      execPath: process.execPath,
      workRoot: updatesDir(),
      onProgress: (p) => {
        if (cancelled || unpacking) return;
        if (p.total && p.transferred >= p.total) {
          // download done: checksum, unzip and signature check follow
          unpacking = true;
          UpdateUI.set({ title: "Verifying and extracting the update…", progress: null, busy: true, detail: fmtMB(p.total), cancel: true });
          return;
        }
        UpdateUI.set({ title: "Downloading Desk Reject " + info.version + "…", progress: p.total ? p.transferred / p.total : null, busy: true,
                       transferred: p.transferred, total: p.total, cancel: true });
      }
    });
    if (cancelled) return;
    // Ready: Install and Relaunch now, or Later (installed when the app quits).
    UpdateUI.set({ offer: true, size: [600, 150], title: "Desk Reject " + info.version + " is ready",
                   subtitle: "Restart to finish the update. If you choose Later, it will be installed when you quit.",
                   primary: "Restart Now", secondary: "Later" }, (action) => {
      if (action === "primary") { UpdateUI.close(); launch({ relaunch: true }); app.quit(); }
      else { pendingMacInstaller = launch; UpdateUI.close(); }
    });
  } catch (err) {
    if (cancelled || (err && err.name === "AbortError")) return;
    // Could not update in place: fall back to downloading the dmg.
    const asset = pickAsset(rel.assets || []);
    await failed("The update could not be installed automatically",
      String(err.message || err) + (asset ? "\n\nThe installer will be downloaded instead." : ""));
    if (asset) downloadInstaller(asset, version);
    else shell.openExternal(releasesURL(repo, rel));
  }
}

app.on("before-quit", () => {
  if (pendingMacInstaller) { const run = pendingMacInstaller; pendingMacInstaller = null; run({ relaunch: false }); }
});

const prefsFile = () => path.join(app.getPath("userData"), "update-prefs.json");
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch (e) { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch (e) { /* ignore */ } }

// The text of the release on GitHub, shortened, for the "available" dialog.
function releaseNotes(rel) {
  const body = String((rel && rel.body) || "").replace(/\r/g, "").replace(/^#+\s*/gm, "").replace(/\*\*|`/g, "").trim();
  if (!body) return "";
  return body.length > 600 ? body.slice(0, 600).replace(/\s+\S*$/, "") + "…" : body;
}

// What's new, for the update window: the CHANGELOG.md bullets of every version
// after the installed one, as plain text (the box scrolls).
async function changelogNotes(repo, latest, current, signal) {
  const clean = (t) => {
    t = t.replace(/^\s*[-*]\s+/, "").replace(/\*\*|`/g, "").replace(/\*([^*]+)\*/g, "$1").trim();
    return t;
  };
  try {
    const res = await net.fetch("https://raw.githubusercontent.com/" + repo + "/v" + latest + "/CHANGELOG.md", { signal });
    if (!res.ok) return [];
    const out = [];
    let take = false;
    (await res.text()).split("\n").forEach((line) => {
      const h = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line);
      if (h) { take = newer(h[1], current) && !newer(h[1], latest); return; }
      if (take && /^\s*[-*]\s+/.test(line)) out.push(clean(line));
    });
    return out.slice(0, 12);
  } catch (_) { return []; }
}

let checking = false;
async function checkForUpdates(manual) {
  if (checking) { if (manual && UpdateUI.isOpen()) UpdateUI.open(); return; }
  const repo = repoSlug();
  if (!repo) {
    if (manual) dialog.showMessageBox(win, { type: "info", message: "Update checks are not configured", detail: "Set the GitHub repository in package.json (\"repository\") or build the app with the release workflow." });
    return;
  }
  checking = true;
  const abort = new AbortController();
  let cancelled = false;
  if (manual) {
    UpdateUI.open();
    UpdateUI.set({ title: "Checking for updates…", progress: null, busy: true, cancel: true }, (action) => {
      if (action === "cancel" || action === "closed") { cancelled = true; abort.abort(); UpdateUI.close(); }
    });
  }
  try {
    const res = await net.fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "Desk-Reject/" + app.getVersion() },
      signal: abort.signal
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    if (cancelled) return;
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    const prefs = readPrefs();
    if (!newer(latest, current)) {
      UpdateUI.close();
      if (manual) await upToDate(repo, current);
      return;
    }
    // "Skip This Version": the check at startup stays silent about that version;
    // Check for Updates… still offers it, and a newer version is offered again
    if (!manual && prefs.skip === latest) return;
    const selfInstall = canSelfInstall();
    let notes = await changelogNotes(repo, latest, current, abort.signal);
    if (cancelled) return;
    if (!notes.length) notes = releaseNotes(rel).split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean).slice(0, 8);
    // "A new version is available": in the update window, Sparkle style
    const response = await new Promise((resolve) => {
      UpdateUI.open();
      UpdateUI.set({
        offer: true, size: [600, notes.length ? 360 : 170],
        title: "Desk Reject " + latest + " is available",
        subtitle: "You have version " + current + ". Would you like to install it now?",
        notes,
        tertiary: "Skip This Version", secondary: "Later",
        primary: selfInstall ? "Install Update" : "Download Update"
      }, (action) => resolve(action));
    });
    if (response === "primary") {
      if (selfInstall) installMacUpdate(rel, repo, latest); // the window switches to the download
      else {
        UpdateUI.close();
        const asset = pickAsset(rel.assets || []);
        if (asset) downloadInstaller(asset, latest);
        else shell.openExternal(releasesURL(repo, rel)); // nothing for this system yet
      }
    } else {
      UpdateUI.close();
      if (response === "tertiary") writePrefs(Object.assign(prefs, { skip: latest }));
    }
  } catch (e) {
    if (cancelled || (e && e.name === "AbortError")) return;
    if (manual) await failed("Could not check for updates", e.message || e);
  } finally {
    checking = false;
  }
}

// ------------------------------------------------------- global shortcuts

// Control+Option (Ctrl+Alt elsewhere) plus the pad's key: the same grid as the
// in-app keyboard, usable while Keynote or PowerPoint is in front.
const PAD_KEYS = "1234QWERASDFZXCV".split("");
function shortcutTable() {
  const t = PAD_KEYS.map((k, i) => ["Control+Alt+" + k, { type: "pad", index: i }]);
  t.push(["Control+Alt+Space", { type: "random" }]);
  t.push(["Control+Alt+Left", { type: "bank", step: -1 }]);
  t.push(["Control+Alt+Right", { type: "bank", step: 1 }]);
  t.push(["Control+Alt+Escape", { type: "stop" }]);
  return t;
}

function setGlobalShortcuts(enabled) {
  globalShortcut.unregisterAll();
  const failed = [];
  if (enabled) {
    for (const [acc, action] of shortcutTable()) {
      const ok = globalShortcut.register(acc, () => { if (win) win.webContents.send("dr:shortcut", action); });
      if (!ok) failed.push(acc.replace("Control+Alt+", ""));
    }
  }
  return { enabled: !!enabled, failed };
}

app.on("will-quit", () => globalShortcut.unregisterAll());

// ------------------------------------------------------------ PDF report

// The page builds the PDF (the same file the web app downloads); here it is
// written where the user chooses, starting from the Documents folder.
async function saveReportPdf(name, bytes) {
  if (!win || !bytes) return { ok: false };
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, "-") || "report.pdf";
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Save referee report",
    defaultPath: path.join(app.getPath("documents"), safe),
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return { ok: true, name: path.basename(filePath) };
}

// ----------------------------------------------------------------- about
// A two-column About window (icon, name and version on the left, credits on
// the right), instead of the standard panel.

let aboutWin = null;
function showAbout() {
  if (aboutWin) { aboutWin.show(); aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    ...centredBounds(760, 420), useContentSize: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: "About Desk Reject",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#232325" : "#ececec",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: { preload: path.join(__dirname, "about-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  aboutWin.setMenuBarVisibility(false);
  aboutWin.webContents.on("will-navigate", (e) => e.preventDefault());
  aboutWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  aboutWin.once("ready-to-show", () => aboutWin.show());
  aboutWin.on("closed", () => { aboutWin = null; });
  aboutWin.loadURL(ORIGIN + "/electron/about-window.html");
}
ipcMain.on("about:open", (e, url) => {
  if (aboutWin && e.sender === aboutWin.webContents && /^https:\/\//.test(url)) shell.openExternal(url);
});

// ------------------------------------------------------------------- menu

function buildMenu() {
  const mac = process.platform === "darwin";
  const check = { label: "Check for Updates…", click: () => checkForUpdates(true) };
  const repo = repoSlug();
  const template = [
    ...(mac ? [{
      label: app.name,
      submenu: [{ label: "About Desk Reject", click: showAbout }, check, { type: "separator" }, { role: "services" }, { type: "separator" },
                { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }]
    }] : [{ label: "File", submenu: [check, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
                               { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "What's New", click: () => { if (win) win.webContents.send("dr:whats-new"); } },
                               ...(mac ? [] : [{ label: "About Desk Reject", click: showAbout }]),
                               ...(repo ? [{ label: "Source Code", click: () => shell.openExternal("https://github.com/" + repo) }] : [])] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ----------------------------------------------------------------- window

// Exact centre of the work area (screen minus menu bar and Dock) of the
// display with the main window, or with the pointer at launch; the size
// shrinks to fit a small screen. macOS's own "center" sits higher than the
// middle, so the position is computed here.
function centredBounds(width, height) {
  let display;
  try {
    display = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds())
                                        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (_) { display = screen.getPrimaryDisplay(); }
  const wa = display.workArea;
  const w = Math.min(width, wa.width - 40), h = Math.min(height, wa.height - 40);
  return { width: w, height: h, x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2) };
}

function createWindow() {
  win = new BrowserWindow({
    ...centredBounds(1280, 820),
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
      nodeIntegration: false,
      backgroundThrottling: false // global shortcuts must play at once while the window is behind
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

// After an update that changes the icon, Dock and Finder can keep showing the
// old one until the user logs out. When the icon file in the bundle differs
// from the one seen at the last launch, re-register the app with Launch
// Services and restart the Dock once. Errors are ignored: never blocks startup.
function refreshMacIconCacheIfChanged() {
  try {
    if (process.platform !== "darwin" || !app.isPackaged) return;
    const bundle = path.dirname(path.dirname(path.dirname(process.execPath))); // X.app/Contents/MacOS/X
    if (!bundle.endsWith(".app")) return;
    const res = path.join(bundle, "Contents", "Resources");
    const iconFile = ["Assets.car", "icon.icns"].map((f) => path.join(res, f)).find((f) => fs.existsSync(f));
    if (!iconFile) return;
    const stateFile = path.join(app.getPath("userData"), "icon-state.json");
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {}; } catch (_) { /* first launch */ }
    const iconHash = require("node:crypto").createHash("sha1").update(fs.readFileSync(iconFile)).digest("hex");
    if (saved.iconHash === iconHash) return;
    const { execFile } = require("node:child_process");
    const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    execFile("/usr/bin/touch", [bundle], () => {
      execFile(lsregister, ["-f", bundle], () => {
        setTimeout(() => execFile("/usr/bin/killall", ["Dock"], () => {}), 1500);
      });
    });
    try { fs.writeFileSync(stateFile, JSON.stringify({ iconHash, version: app.getVersion() })); } catch (_) { /* ignore */ }
  } catch (_) { /* ignore */ }
}

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

  ipcMain.handle("dr:global-shortcuts", (_e, enabled) => setGlobalShortcuts(!!enabled));
  ipcMain.handle("dr:save-pdf", (_e, name, bytes) => saveReportPdf(name, bytes));
  if (process.platform === "darwin" && app.isPackaged) macUpdater.cleanup({ execPath: process.execPath, workRoot: updatesDir() });

  nativeTheme.on("updated", applyTheme);
  buildMenu();
  createWindow();
  refreshMacIconCacheIfChanged();
  setTimeout(() => checkForUpdates(false), 4000);

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
