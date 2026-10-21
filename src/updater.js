// In-app updates. On Windows the update is downloaded and installed from inside the app (electron-updater reads the releases of the repository
// named in package.json > build.publish). On macOS an app that is not code-signed cannot replace itself, so there the button opens the download
// page instead; once the app is signed the same code can download and install there too (set SIGNED_MAC = true).
const { app, shell } = require('electron');

const SIGNED_MAC = false;
const RELEASES = 'https://github.com/Rizqaputraaa/Atuls/releases/latest';

let au = null, state = { status: 'idle', version: app.getVersion(), latest: '', progress: 0, error: '', manual: false };
let listener = () => {}, timer = null;
const set = (patch) => { state = { ...state, ...patch }; try { listener(state); } catch {} };

function init(onChange, log = () => {}) {
  listener = onChange;
  if (!app.isPackaged) return; // a development run has nothing to update
  try {
    au = require('electron-updater').autoUpdater;
  } catch (e) { log('updater unavailable: ' + e.message); return; }
  au.autoDownload = false;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false;
  const manual = process.platform === 'darwin' && !SIGNED_MAC;
  au.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  au.on('update-available', (i) => { log('update available: ' + i.version); set({ status: 'available', latest: i.version, manual }); });
  au.on('update-not-available', () => set({ status: 'current' }));
  au.on('download-progress', (p) => set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
  au.on('update-downloaded', (i) => { log('update downloaded: ' + i.version); set({ status: 'ready', latest: i.version, progress: 100 }); });
  au.on('error', (e) => { log('update error: ' + (e && e.message ? e.message.split('\n')[0] : e)); set({ status: 'error', error: 'Could not check for updates' }); });
  // a check shortly after start, then every 6 hours
  setTimeout(check, 20000).unref();
  timer = setInterval(check, 6 * 3600 * 1000); timer.unref();
}

function check() {
  if (!au || ['checking', 'downloading', 'ready'].includes(state.status)) return Promise.resolve(state);
  return au.checkForUpdates().then(() => state).catch(() => state);
}

// Windows: download, then restart into the new version. macOS (unsigned): open the download page.
async function install() {
  if (!au) return state;
  if (state.manual) { shell.openExternal(RELEASES); return state; }
  if (state.status === 'ready') { au.quitAndInstall(false, true); return state; }
  if (state.status === 'available') { set({ status: 'downloading', progress: 0 }); try { await au.downloadUpdate(); } catch { /* the error event reports it */ } }
  return state;
}

module.exports = { init, check, install, get state() { return state; } };
