// mac-updater.js: self-update for the unsigned macOS build (same code as Magic Calendar).
//
// electron-updater can check GitHub releases on macOS, but its installer (Squirrel.Mac) only accepts
// an update signed with the same Developer ID as the running app, which an ad-hoc signed app does not
// have. So on macOS the update is installed here:
//   1. pick the .zip for this architecture from the release metadata (latest-mac.yml),
//   2. download it (files written by the app itself are not quarantined by macOS),
//   3. verify its SHA-512 against the metadata,
//   4. unpack it with ditto,
//   5. after the app quits, a small script swaps the old .app with the new one and relaunches it.
// If the app cannot replace itself (run from the DMG, from a translocated path, or from a folder the
// user cannot write to), the caller falls back to opening the download page.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// latest-mac.yml, as written by electron-builder: a version and a list of files with
// their base64 SHA-512. Only the few fields used here are read.
function parseLatestYml(text) {
  const out = { version: null, files: [] };
  const v = /^version:\s*['"]?([^'"\s]+)/m.exec(text);
  if (v) out.version = v[1];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^\s*-\s*url:\s*['"]?(.+?)['"]?\s*$/.exec(line))) { cur = { url: m[1] }; out.files.push(cur); }
    else if (cur && (m = /^\s+sha512:\s*['"]?(.+?)['"]?\s*$/.exec(line))) cur.sha512 = m[1];
    else if (cur && (m = /^\s+size:\s*(\d+)/.exec(line))) cur.size = Number(m[1]);
    else if (/^\S/.test(line)) cur = null;
  }
  return out;
}

// files: UpdateInfo.files from electron-updater ([{ url, sha512, size }]).
// The zips are named "<Name>-<version>-mac-arm64.zip" and "<Name>-<version>-mac-x64.zip" (1.1.1+);
// 1.1.0 used "-arm64-mac.zip" / "-x64-mac.zip". Matching only on ".zip" and "arm64" works for both,
// so versions already installed keep finding their update.
function pickMacZip(files, arch) {
  const zips = (files || []).filter(f => /\.zip$/i.test(f.url || ''));
  if (!zips.length) return null;
  const isArm = /arm64/i;
  if (arch === 'arm64') return zips.find(f => isArm.test(f.url)) || null;
  return zips.find(f => !isArm.test(f.url)) || null;
}

function assetUrl(repo, version, fileUrl) {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(fileUrl)}`;
}

// Downloads url to dest with progress, verifying the base64 SHA-512 from the release metadata.
// fetchImpl: Electron's net.fetch (follows GitHub's redirects to its storage).
async function download(fetchImpl, url, dest, expectedSha512, onProgress) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash  = crypto.createHash('sha512');
  const out   = fs.createWriteStream(dest);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!out.write(buf)) await new Promise(r => out.once('drain', r));
      received += buf.length;
      if (onProgress) onProgress({ transferred: received, total, percent: total ? (received / total) * 100 : 0 });
    }
  } finally {
    await new Promise(r => out.end(r));
  }
  const digest = hash.digest('base64');
  if (expectedSha512 && digest !== expectedSha512) {
    try { fs.unlinkSync(dest); } catch (_) {}
    throw new Error('downloaded file is corrupted (checksum mismatch)');
  }
  return dest;
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], err => err ? reject(err) : resolve());
  });
}

function findApp(dir) {
  const name = fs.readdirSync(dir).find(n => n.endsWith('.app'));
  return name ? path.join(dir, name) : null;
}

// /Applications/Desk Reject.app/Contents/MacOS/Desk Reject -> /Applications/Desk Reject.app
function currentBundlePath(execPath) {
  const p = path.resolve(execPath, '..', '..', '..');
  return p.endsWith('.app') ? p : null;
}

// Returns null if the running app can replace itself, otherwise a short reason.
function selfInstallBlocker(bundlePath) {
  if (!bundlePath) return 'not-a-bundle';
  if (bundlePath.includes('/AppTranslocation/')) return 'translocated';
  if (bundlePath.startsWith('/Volumes/')) return 'running-from-dmg';
  try {
    fs.accessSync(path.dirname(bundlePath), fs.constants.W_OK);
    fs.accessSync(bundlePath, fs.constants.W_OK);
  } catch (_) {
    return 'not-writable';
  }
  return null;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// $1 = 1 to reopen the app after the swap ("Restart now"), 0 to leave it closed ("Later").
function installScript({ pid, oldApp, newApp, workDir, logFile }) {
  return `#!/bin/bash
# Desk Reject updater: waits for the app to quit, checks the new bundle, swaps it in, relaunches.
RELAUNCH="\${1:-1}"
PID=${Number(pid)}
OLD=${shQuote(oldApp)}
NEW=${shQuote(newApp)}
WORK=${shQuote(workDir)}
LOG=${shQuote(logFile)}
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
if ! /usr/bin/codesign --verify --deep "$NEW" 2>>"$LOG"; then
  log "update aborted: new app missing or its signature is broken"
  rm -rf "$WORK"
  [ "$RELAUNCH" = 1 ] && open "$OLD"
  exit 1
fi
BACKUP="$OLD.update-old"
rm -rf "$BACKUP"
if mv "$OLD" "$BACKUP"; then
  if mv "$NEW" "$OLD"; then
    rm -rf "$BACKUP"
    log "updated $OLD"
  else
    mv "$BACKUP" "$OLD"
    log "update failed: could not move the new app into place, old app restored"
  fi
else
  log "update failed: could not move the old app (permissions?)"
fi
xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
[ "$RELAUNCH" = 1 ] && open "$OLD"
rm -rf "$WORK"
`;
}

// Leftovers of an interrupted update: the old bundle next to the app, and old work folders.
function cleanup({ execPath, workRoot }) {
  const bundle = currentBundlePath(execPath);
  if (bundle) {
    try { fs.rmSync(`${bundle}.update-old`, { recursive: true, force: true }); } catch (_) {}
  }
  try {
    for (const name of fs.readdirSync(workRoot)) {
      if (name.startsWith('work-')) fs.rmSync(path.join(workRoot, name), { recursive: true, force: true });
    }
  } catch (_) {}
}

// Full flow up to the point where the app must quit. Returns a function that starts the swap
// script; the caller runs it and then quits the app.
async function prepareUpdate({ fetchImpl, repo, info, arch, execPath, workRoot, onProgress }) {
  const bundle  = currentBundlePath(execPath);
  const blocker = selfInstallBlocker(bundle);
  if (blocker) { const e = new Error(`cannot self-install: ${blocker}`); e.code = blocker; throw e; }

  const file = pickMacZip(info.files, arch);
  if (!file) throw new Error(`no zip for ${arch} in release ${info.version}`);

  // Work folder inside the app's own data (macOS empties the system temp folder after a few days).
  fs.mkdirSync(workRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'work-'));
  try {
    const zipPath = path.join(workDir, 'update.zip');
    await download(fetchImpl, assetUrl(repo, info.version, file.url), zipPath, file.sha512, onProgress);

    const unpackDir = path.join(workDir, 'app');
    fs.mkdirSync(unpackDir);
    await unzip(zipPath, unpackDir);
    fs.unlinkSync(zipPath);
    const newApp = findApp(unpackDir);
    if (!newApp) throw new Error('no .app inside the update zip');

    const scriptPath = path.join(workDir, 'install.sh');
    const logFile = path.join(workRoot, 'update.log');
    fs.writeFileSync(scriptPath, installScript({ pid: process.pid, oldApp: bundle, newApp, workDir, logFile }), { mode: 0o755 });

    return function launchInstaller({ relaunch }) {
      const child = spawn('/bin/bash', [scriptPath, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
      child.unref();
    };
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

// "1.10.0" > "1.9.2"
function isNewer(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

module.exports = { parseLatestYml, pickMacZip, assetUrl, download, currentBundlePath, selfInstallBlocker, installScript, prepareUpdate, cleanup, isNewer, shQuote };
