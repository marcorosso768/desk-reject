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

// ---- the update window (Sparkle style, the same sizes and options as Magic
// Calendar): one small window shows every step (checking, up to date, update
// available with the release notes, downloading, ready to install, errors).
// The main process decides the state; update-window.js only draws it and sends
// back the id of the button pressed.

const UPD_W_SMALL = 460, UPD_W_WIDE = 600;   // compact for short messages, wide with notes or three buttons
let uw = null, uwShown = false;
let updState = null;        // state shown in the update window
let available = null;       // update found by the last check: { rel, repo, version, current, notes, selfInstall }
let checkToken = 0;         // a cancelled check ignores its result
let dlAbort = null;         // cancels the running download
let pendingMacInstaller = null, pendingMacVersion = null, pendingRelaunch = false;

const updWidth = (st) => (st && ((st.notes && st.notes.length) || (st.buttons || []).length > 2) ? UPD_W_WIDE : UPD_W_SMALL);
function accentColor() {
  try { if (process.platform === "darwin" && systemPreferences.getAccentColor) return "#" + systemPreferences.getAccentColor().slice(0, 6); } catch (_) {}
  return "";
}

function centreUpdateWindow() {
  const [w, h] = uw.getSize(), wa = screen.getDisplayMatching(uw.getBounds()).workArea;
  uw.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2));
}
function showUpdateWindow() {
  if (!uw || uwShown) return;
  uwShown = true;
  centreUpdateWindow();
  uw.show();
}

function openUpdateWindow() {
  if (uw) { uw.show(); uw.focus(); return; }
  uwShown = false;
  uw = new BrowserWindow({
    ...centredBounds(updWidth(updState), 170), useContentSize: true,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: "Updating Desk Reject", show: false, skipTaskbar: true,
    parent: win && !win.isDestroyed() ? win : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#2a2a2c" : "#ececec",
    webPreferences: { preload: path.join(__dirname, "update-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  uw.setMenuBarVisibility(false);
  uw.webContents.on("will-navigate", (e) => e.preventDefault());
  uw.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  uw.webContents.once("did-finish-load", () => {
    if (updState && uw) uw.webContents.send("upd:state", updState);
    setTimeout(showUpdateWindow, 400); // normally shown earlier, at its first resize
  });
  uw.on("closed", () => {
    uw = null;
    // closing while checking cancels the check, while downloading cancels the download;
    // closing an update that is available means "later"; a ready update stays ready
    const kind = updState && updState.kind;
    if (kind === "downloading") { if (dlAbort) dlAbort(); dlAbort = null; updState = null; dockProgress(null); }
    else if (kind !== "ready") { if (kind === "checking") checkToken++; updState = null; }
  });
  uw.loadURL(ORIGIN + "/electron/update-window.html");
}

ipcMain.on("upd:action", (e, id) => {
  if (uw && e.sender === uw.webContents) onUpdateAction(String(id));
});
ipcMain.on("upd:resize", (e, height) => {
  if (!uw || e.sender !== uw.webContents) return;
  const h = Math.max(110, Math.min(700, Math.round(Number(height) || 0)));
  const [w, cur] = uw.getContentSize();
  if (h !== cur) { uw.setContentSize(w, h); centreUpdateWindow(); } // only when the height really changes
  showUpdateWindow();
});

function dockProgress(st) {
  if (!win || win.isDestroyed()) return;
  if (st && st.kind === "downloading") win.setProgressBar(typeof st.progress === "number" ? st.progress / 100 : 2);
  else win.setProgressBar(-1);
}

function setUpdateState(st, { show = true } = {}) {
  updState = Object.assign({ accent: accentColor() }, st);
  dockProgress(updState);
  if (uw) {
    const w = updWidth(updState), [cw, ch] = uw.getContentSize();
    if (cw !== w) { uw.setContentSize(w, ch); centreUpdateWindow(); }
    uw.webContents.send("upd:state", updState);
  } else if (show) openUpdateWindow();
}
function closeUpdateWindow() { if (uw) uw.close(); }

// ---- the states

const fmtMB = (n) => (n / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " MB";
const prefsFile = () => path.join(app.getPath("userData"), "update-prefs.json");
function readPrefs() { try { return JSON.parse(fs.readFileSync(prefsFile(), "utf8")); } catch (e) { return {}; } }
function writePrefs(p) { try { fs.writeFileSync(prefsFile(), JSON.stringify(p)); } catch (e) { /* ignore */ } }
const getAutoUpdate = () => !!readPrefs().autoUpdate;
function setAutoUpdate(on) {
  writePrefs(Object.assign(readPrefs(), { autoUpdate: !!on }));
  if (updState && updState.checkbox) updState.checkbox.checked = !!on;
}
// The checkbox "Automatically download and install updates in the future": only
// where Desk Reject can replace itself (the installed Mac app).
const autoCheckbox = () => (canSelfInstall() ? { id: "auto", label: "Automatically download and install updates in the future", checked: getAutoUpdate() } : undefined);

const stChecking = () => ({ kind: "checking", title: "Checking for updates…", progress: "indeterminate", buttons: [{ id: "cancel", label: "Cancel" }] });
const stUpToDate = () => ({ kind: "uptodate", title: "You’re up to date!", message: "Desk Reject " + app.getVersion() + " is the newest version available.",
  buttons: [{ id: "close", label: "OK", primary: true }, { id: "history", label: "Version History" }] });
// AlDente, LaunchOS: title, message, "Release Notes:", the checkbox, then Skip | Remind Me Later | Install Update
const stAvailable = (a) => ({ kind: "available", title: "A new version of Desk Reject is available!",
  message: "Desk Reject " + a.version + " is now available, you have " + a.current + ". Would you like to download it now?",
  notesLabel: "Release Notes:", notes: a.notes, checkbox: autoCheckbox(),
  buttons: [{ id: "install", label: a.selfInstall ? "Install Update" : "Download Update", primary: true }, { id: "later", label: "Remind Me Later" },
    { id: "skip", label: "Skip This Version", left: true }] });
// bar plus "12.5 MB of 116.1 MB" on the left and Cancel on the right
function stDownloading(version, p = {}) {
  const total = Number(p.total) || 0, done = Number(p.transferred) || 0;
  return { kind: "downloading", title: "Downloading Desk Reject " + version + "…",
    progress: p.verifying ? "indeterminate" : (total ? Math.min(100, (done / total) * 100) : 0),
    detail: p.verifying ? "Verifying the update…" : (total ? fmtMB(done) + " of " + fmtMB(total) : "Connecting…"),
    buttons: [{ id: "canceldl", label: "Cancel" }] };
}
// after a download the user started: compact (LaunchOS), full bar
const stReady = () => ({ kind: "ready", title: "Ready to Install", progress: 100,
  buttons: [{ id: "restart", label: "Install and Relaunch", primary: true }, { id: "later", label: "Install on Quit" }] });
// after an automatic download (AlDente): the notes, the checkbox, Skip | Install on Quit | Install and Relaunch
const stReadyFull = (a) => ({ kind: "ready", title: "A new version of Desk Reject is ready to install!",
  message: "Desk Reject " + a.version + " has been downloaded and is ready to use. Would you like to install it and relaunch now?",
  notesLabel: "Release Notes:", notes: a.notes, checkbox: autoCheckbox(),
  buttons: [{ id: "restart", label: "Install and Relaunch", primary: true }, { id: "later", label: "Install on Quit" },
    { id: "skip", label: "Skip This Version", left: true }] });
const stError = (detail) => ({ kind: "error", title: "Update check failed",
  message: "Check your connection and try again later." + (detail ? "\n\n" + detail : ""),
  buttons: [{ id: "close", label: "Close", primary: true }, { id: "releases", label: "Open Releases Page" }] });
// the Mac app could not replace itself: download the installer instead
const stManual = (detail, canDownload) => ({ kind: "manual", title: "The update could not be installed automatically.", message: detail,
  buttons: [canDownload ? { id: "dmg", label: "Download Installer", primary: true } : { id: "releases", label: "Open Releases Page", primary: true },
    { id: "close", label: "Close" }] });

// The download reports progress for every chunk: the window is updated at most
// every 150 ms, and always at the end.
let lastProgressAt = 0;
function sendProgress(version, p) {
  const now = Date.now();
  if (now - lastProgressAt < 150 && !(p.total && p.transferred >= p.total)) return;
  lastProgressAt = now;
  setUpdateState(stDownloading(version, p), { show: false });
}

// ---- release notes

// The text of the release on GitHub, when the changelog cannot be read.
function releaseNotes(rel) {
  return String((rel && rel.body) || "").replace(/\r/g, "").split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/\*\*|`/g, "").replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean).slice(0, 8);
}

// What's new: the CHANGELOG.md bullets of every version after the installed one,
// newest first, one block per version (the box scrolls).
async function changelogNotes(repo, latest, current) {
  const clean = (t) => t.replace(/^\s*[-*]\s+/, "").replace(/\*\*|`/g, "").replace(/\*([^*]+)\*/g, "$1").trim();
  try {
    const res = await net.fetch("https://raw.githubusercontent.com/" + repo + "/v" + latest + "/CHANGELOG.md");
    if (!res.ok) return [];
    const out = [];
    let cur = null;
    (await res.text()).split("\n").forEach((line) => {
      const h = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line);
      if (h) {
        cur = newer(h[1], current) && !newer(h[1], latest) ? { version: h[1], items: [] } : null;
        if (cur) out.push(cur);
        return;
      }
      if (cur && /^\s*[-*]\s+/.test(line)) cur.items.push(clean(line));
    });
    return out.filter((r) => r.items.length).slice(0, 10);
  } catch (_) { return []; }
}

const shortDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

// ---- checking

async function checkForUpdates(manual) {
  // a download is running or an update is waiting: show where it is instead of checking again
  if (updState && (updState.kind === "downloading" || updState.kind === "ready")) {
    if (manual) setUpdateState(updState);
    return;
  }
  const repo = repoSlug();
  if (!repo) {
    if (manual) setUpdateState({ kind: "error", title: "Update checks are not configured",
      message: "Set the GitHub repository in package.json (\"repository\") or build the app with the release workflow.",
      buttons: [{ id: "close", label: "OK", primary: true }] });
    return;
  }
  const token = ++checkToken;
  if (manual) setUpdateState(stChecking());
  try {
    const res = await net.fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "Desk-Reject/" + app.getVersion() }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rel = await res.json();
    if (token !== checkToken) return;                     // cancelled meanwhile
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    if (!newer(latest, current)) { if (manual) setUpdateState(stUpToDate()); return; }
    let notes = await changelogNotes(repo, latest, current);
    if (token !== checkToken) return;
    if (!notes.length) { const items = releaseNotes(rel); if (items.length) notes = [{ version: latest, items }]; }
    if (notes.length && notes[0].version === latest) notes[0].date = shortDate(rel.published_at);
    available = { rel, repo, version: latest, current, notes, selfInstall: canSelfInstall() };
    // "Skip This Version": the check at launch stays silent about that version;
    // Check for Updates… still offers it, and a newer version is offered again
    if (!manual && readPrefs().skip === latest) return;
    // automatic updates: no window until the update is ready
    if (!manual && available.selfInstall && getAutoUpdate()) return startUpdate({ background: true });
    setUpdateState(stAvailable(available));               // also at launch: the window opens
  } catch (e) {
    if (token !== checkToken) return;
    if (manual) setUpdateState(stError(String((e && e.message) || e)));
  }
}

function startUpdate({ background = false } = {}) {
  const a = available;
  if (!a) return closeUpdateWindow();
  if (a.selfInstall) return installMacUpdate(a, { background });
  const asset = pickAsset(a.rel.assets || []);
  if (asset) downloadInstaller(asset, a.version);
  else { closeUpdateWindow(); shell.openExternal(releasesURL(a.repo, a.rel)); } // nothing for this system yet
}

const releasesURL = (repo, rel) => (rel && rel.html_url) || "https://github.com/" + repo + "/releases";

// Windows and Linux (and a Mac that cannot replace itself): download the
// installer with the update window, then open it.
function downloadInstaller(asset, version) {
  if (!win) return;
  const ses = win.webContents.session;
  let item = null, cancelled = false;
  setUpdateState(stDownloading(version));
  dlAbort = () => { cancelled = true; if (item) item.cancel(); };
  ses.once("will-download", (_e, it) => {
    item = it;
    if (cancelled) { item.cancel(); return; }
    const target = path.join(app.getPath("downloads"), asset.name);
    item.setSavePath(target);
    item.on("updated", () => {
      if (cancelled) return;
      sendProgress(version, { transferred: item.getReceivedBytes(), total: item.getTotalBytes() || asset.size || 0 });
    });
    item.once("done", async (_e2, st) => {
      dlAbort = null;
      if (cancelled || st === "cancelled") return;
      if (st !== "completed") {
        setUpdateState(stManual("The download did not finish. Try again with Check for Updates…, or download it from the Releases page.", false));
        return;
      }
      updState = null;
      closeUpdateWindow();
      dockProgress(null);
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

function canSelfInstall() {
  if (process.platform !== "darwin" || !app.isPackaged) return false; // never touch the Electron used by npm start
  return !macUpdater.selfInstallBlocker(macUpdater.currentBundlePath(process.execPath));
}

// background: the automatic update. The download runs without a window (progress
// in the Dock only), and the window appears once the update is ready.
async function installMacUpdate(a, { background = false } = {}) {
  // already downloaded earlier (Install on Quit): no second download
  if (!pendingMacInstaller || pendingMacVersion !== a.version) {
    setUpdateState(stDownloading(a.version), { show: !background });
    const ctrl = new AbortController();
    dlAbort = () => ctrl.abort();
    try {
      const yml = (a.rel.assets || []).find((x) => x.name === "latest-mac.yml");
      if (!yml) throw new Error("the release has no latest-mac.yml");
      const res = await net.fetch(yml.browser_download_url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("latest-mac.yml: HTTP " + res.status);
      const info = macUpdater.parseLatestYml(await res.text());
      info.version = info.version || a.version;
      pendingMacInstaller = await macUpdater.prepareUpdate({
        fetchImpl: (u) => net.fetch(u, { signal: ctrl.signal }),
        repo: a.repo,
        info,
        arch: macArch(),
        execPath: process.execPath,
        workRoot: updatesDir(),
        onProgress: (p) => {
          if (ctrl.signal.aborted) return;
          // download done: checksum, unzip and signature check follow
          if (p.total && p.transferred >= p.total) setUpdateState(stDownloading(a.version, { verifying: true }), { show: false });
          else sendProgress(a.version, p);
        }
      });
      pendingMacVersion = a.version;
    } catch (err) {
      if (ctrl.signal.aborted || (err && err.name === "AbortError")) return; // cancelled: the window is already closed
      if (background) { updState = null; dockProgress(null); return; }    // automatic: silent, a manual check shows the problem
      const asset = pickAsset(a.rel.assets || []);
      setUpdateState(stManual(String((err && err.message) || err) + (asset ? "\n\nYou can download the installer instead." : ""), !!asset));
      return;
    } finally {
      dlAbort = null;
    }
  }
  setUpdateState(background ? stReadyFull(a) : stReady());
}

function discardDownloadedUpdate() {
  pendingMacInstaller = null; pendingMacVersion = null;
  try { macUpdater.cleanup({ execPath: process.execPath, workRoot: updatesDir() }); } catch (_) { /* ignore */ }
}

// the buttons of the update window
function onUpdateAction(id) {
  const kind = updState && updState.kind;
  switch (id) {
    case "install": startUpdate(); break;
    case "restart": pendingRelaunch = true; app.quit(); break;   // the installer starts in before-quit
    case "history": shell.openExternal("https://github.com/" + repoSlug() + "/releases"); break;
    case "releases": shell.openExternal(available ? releasesURL(available.repo, available.rel) : "https://github.com/" + repoSlug() + "/releases"); break;
    case "dmg": {
      const asset = available && pickAsset(available.rel.assets || []);
      if (asset) downloadInstaller(asset, available.version); else closeUpdateWindow();
      break;
    }
    case "cancel": checkToken++; updState = null; closeUpdateWindow(); break;
    case "canceldl": if (dlAbort) dlAbort(); dlAbort = null; updState = null; dockProgress(null); closeUpdateWindow(); break;
    case "skip":
      if (available) writePrefs(Object.assign(readPrefs(), { skip: available.version }));
      if (kind === "ready") discardDownloadedUpdate();   // already downloaded: not installed at quit
      updState = null; closeUpdateWindow(); break;
    case "auto:on": setAutoUpdate(true); break;
    case "auto:off": setAutoUpdate(false); break;
    case "escape": if (kind !== "downloading") { if (kind === "checking") checkToken++; closeUpdateWindow(); } break;
    default: closeUpdateWindow();   // close, later (a ready update is installed when the app quits)
  }
}

app.on("before-quit", () => {
  if (pendingMacInstaller) {
    const run = pendingMacInstaller;
    pendingMacInstaller = null;
    run({ relaunch: pendingRelaunch });
  }
});

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
let lastPdfDir = null; // the folder chosen last time, for the next report
async function saveReportPdf(name, bytes) {
  if (!win || !bytes) return { ok: false };
  const safe = String(name).replace(/[\\/:*?"<>|]+/g, "-") || "report.pdf";
  const opts = {
    title: "Save referee report",
    defaultPath: path.join(lastPdfDir || app.getPath("documents"), safe),
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  };
  // macOS: a free-standing save panel, not a sheet attached to the window. With
  // the hidden title bar, a sheet whose folder is changed could stay open out of
  // sight and keep the window modal, so that nothing could be clicked any more.
  const { canceled, filePath } = process.platform === "darwin"
    ? await dialog.showSaveDialog(opts)
    : await dialog.showSaveDialog(win, opts);
  if (win && !win.isDestroyed()) { win.focus(); win.webContents.focus(); }
  if (canceled || !filePath) return { ok: false };
  try {
    fs.writeFileSync(filePath, Buffer.from(bytes));
  } catch (err) {
    return { ok: false, error: "The file could not be written: " + (err.code === "EACCES" || err.code === "EPERM" ? "Desk Reject has no permission for that folder." : err.message) };
  }
  lastPdfDir = path.dirname(filePath);
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
