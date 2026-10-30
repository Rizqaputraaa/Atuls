// The radial menu: a ring of shortcuts that opens under the pointer (press of the mouse wheel or a side button).
// The ring holds quick actions and workspaces (groups of apps, links and folders); everything is configured in its own settings
// window. Configuration lives on this computer only.
const { app, BrowserWindow, screen, shell, dialog, ipcMain, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const Wheel = require('./assets/wheel.js');

let D = null; // { store, link, toast, pickColor, saveColor, MAC }
const MAC = process.platform === 'darwin';

// ---------------------------------------------------------------- configuration
const ACTIONS = {
  pickColor: 'Pick color', screenshot: 'Screenshot', missionControl: MAC ? 'Mission Control' : 'Task View',
  desktopLeft: 'Previous desktop', desktopRight: 'Next desktop', back: 'Back', forward: 'Forward',
};
const LIMIT = { items: 8, workspaces: 8, shortcuts: 8 };
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const newId = () => 'w' + Math.random().toString(36).slice(2, 8);

function defaultCfg() {
  // first run: carry over what the earlier, simpler version stored (three slots and one list of apps)
  const apps = D.store.get('radialApps', []), meta = D.store.get('appMeta', {});
  return {
    mode: 'click', zone: 45,
    appearance: { ...Wheel.DEFAULTS },
    items: [{ type: 'action', action: 'pickColor' }, { type: 'action', action: 'screenshot' }, { type: 'workspace', ws: 'apps' }],
    workspaces: [{ id: 'apps', name: 'Apps', items: apps.slice(0, LIMIT.shortcuts).map((p) => ({ kind: 'app', path: p, name: (meta[p] && meta[p].name) || appName(p), logo: (meta[p] && meta[p].logo) || '' })) }],
  };
}

function sanitize(c) {
  c = c || {};
  const a = c.appearance || {};
  const out = {
    mode: 'click', // the hold gesture was removed
    zone: clamp(c.zone, 20, 120, 45),
    appearance: { radius: clamp(a.radius, 70, 200, Wheel.DEFAULTS.radius), icon: clamp(a.icon, 40, 80, Wheel.DEFAULTS.icon), spacing: clamp(a.spacing, 0, 40, Wheel.DEFAULTS.spacing) },
    workspaces: [],
  };
  const seen = new Set();
  for (const w of (Array.isArray(c.workspaces) ? c.workspaces : []).slice(0, LIMIT.workspaces)) {
    let id = str(w && w.id, 12) || newId();
    if (seen.has(id)) id = newId();
    seen.add(id);
    const items = [];
    for (const it of (Array.isArray(w && w.items) ? w.items : []).slice(0, LIMIT.shortcuts)) {
      const kind = it && it.kind;
      if (kind === 'app' && str(it.path, 500)) items.push({ kind, path: str(it.path, 500), name: str(it.name, 60) || appName(it.path), logo: str(it.logo, 500) });
      else if (kind === 'folder' && str(it.path, 500)) items.push({ kind, path: str(it.path, 500), name: str(it.name, 60) || path.basename(it.path), logo: str(it.logo, 500) });
      else if (kind === 'url' && /^(https?:\/\/|mailto:)/i.test(str(it.url, 800))) items.push({ kind, url: str(it.url, 800), name: str(it.name, 60) || str(it.url, 800).replace(/^https?:\/\/(www\.)?/i, '').split('/')[0], logo: str(it.logo, 500) });
    }
    out.workspaces.push({ id, name: str(w && w.name, 30) || 'Workspace', logo: str(w && w.logo, 500), items });
  }
  out.items = [];
  for (const it of (Array.isArray(c.items) ? c.items : []).slice(0, LIMIT.items)) {
    if (it && it.type === 'action' && ACTIONS[it.action]) out.items.push({ type: 'action', action: it.action, logo: str(it.logo, 500) });
    else if (it && it.type === 'workspace' && seen.has(it.ws)) out.items.push({ type: 'workspace', ws: it.ws });
  }
  return out;
}

const getCfg = () => { const s = D.store.get('radialCfg', null); return sanitize(s || defaultCfg()); };
const setCfg = (c) => { const v = sanitize(c); D.store.set('radialCfg', v); return v; };

// ---------------------------------------------------------------- apps: icons, search, launching
const iconCache = new Map();
const appName = (p) => path.basename(String(p)).replace(/\.(exe|app|lnk)$/i, '');

// macOS: app.getFileIcon crashed the whole app on this Mac (SIGTRAP in a thread-pool worker), so the icon is read from the bundle
// itself: Contents/Resources/<CFBundleIconFile>.icns, turned into a small png by the system tool sips
function macAppIcon(p) {
  const { execFileSync } = require('child_process');
  try {
    const res = path.join(p, 'Contents', 'Resources');
    let name = '';
    try { name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(p, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 2000 }).trim(); } catch {}
    const candidates = [];
    if (name) candidates.push(/\.icns$/i.test(name) ? name : name + '.icns');
    const all = fs.existsSync(res) ? fs.readdirSync(res).filter((f) => /\.icns$/i.test(f)) : [];
    candidates.push(...all.filter((f) => /^appicon/i.test(f)), ...all);
    for (const c of candidates) {
      const f = path.join(res, c);
      if (!fs.existsSync(f)) continue;
      const cache = path.join(os.tmpdir(), 'island-link-icons');
      fs.mkdirSync(cache, { recursive: true });
      const out = path.join(cache, require('crypto').createHash('md5').update(f).digest('hex') + '.png');
      if (!fs.existsSync(out)) execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', f, '--out', out], { stdio: 'ignore', timeout: 4000 });
      const img = nativeImage.createFromPath(out);
      if (!img.isEmpty()) return img.toDataURL();
    }
  } catch {}
  return '';
}
async function appIcon(p, logo) {
  const key = p + '|' + (logo || '');
  if (iconCache.has(key)) return iconCache.get(key);
  let url = '';
  if (logo) { try { const img = nativeImage.createFromPath(logo); if (!img.isEmpty()) url = img.resize({ width: 64 }).toDataURL(); } catch {} }
  if (!url && MAC) url = macAppIcon(p);
  if (!url && !MAC) {
    const fromFile = async (q) => { try { const img = await app.getFileIcon(q, { size: 'large' }); return img.isEmpty() ? '' : img.toDataURL(); } catch { return ''; } };
    try {
      if (/\.lnk$/i.test(p)) {
        // a shortcut's own icon is a generic arrow-on-paper: use what it points to (its icon file, or the program itself)
        const l = shell.readShortcutLink(p);
        for (const q of [l.icon, l.target]) {
          const e = q && q.replace(/%([^%]+)%/g, (_m, n) => process.env[n] || _m);
          if (!e || !fs.existsSync(e)) continue;
          url = /\.ico$/i.test(e) ? nativeImage.createFromPath(e).resize({ width: 64 }).toDataURL() : await fromFile(e);
          if (url) break;
        }
      }
      if (!url && !/^shell:/i.test(p)) url = await fromFile(p);
    } catch {}
  }
  iconCache.set(key, url);
  return url;
}

// The icon of a link: a picture the user chose, else the site's own icon (https://site/favicon.ico, then the icon service of Google as a second try:
// only the site name is asked there). Remembered on disk, so the wheel does not need the network after the first time.
const FAV_FILE = () => path.join(app.getPath('userData'), 'radial-icons.json');
let favCache = null;
const favLoad = () => { if (!favCache) { try { favCache = JSON.parse(fs.readFileSync(FAV_FILE(), 'utf8')); } catch { favCache = {}; } } return favCache; };
const favSave = () => { try { const k = Object.keys(favCache); if (k.length > 200) for (const x of k.slice(0, k.length - 150)) delete favCache[x]; fs.writeFileSync(FAV_FILE(), JSON.stringify(favCache)); } catch {} };
async function fetchIcon(u) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'A-tuls' } });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 400000) return '';
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? '' : img.resize({ width: 64 }).toDataURL();
  } catch { return ''; } finally { clearTimeout(t); }
}
async function linkIcon(u, logo) {
  if (logo) { try { const img = nativeImage.createFromPath(logo); if (!img.isEmpty()) return img.resize({ width: 64 }).toDataURL(); } catch {} }
  let host = '';
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) return ''; host = x.hostname; } catch { return ''; }
  const c = favLoad();
  if (c[host] !== undefined) return c[host];
  let url = await fetchIcon('https://' + host + '/favicon.ico');
  if (!url) url = await fetchIcon('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64');
  if (url) { c[host] = url; favSave(); } // (a failed try is not remembered: the network may have been away)
  return url;
}
// a picture the user chose for a wheel entry or a workspace
async function logoUrl(p) {
  if (!p) return '';
  try { const img = nativeImage.createFromPath(p); return img.isEmpty() ? '' : img.resize({ width: 64 }).toDataURL(); } catch { return ''; }
}
async function itemIcon(it) {
  if (!it) return '';
  if (it.kind === 'logo') return logoUrl(it.logo);
  if (it.kind === 'url') return linkIcon(it.url, it.logo);
  if (it.kind === 'app' || it.kind === 'folder') return appIcon(it.path, it.logo);
  return '';
}

function launch(item) {
  const name = item.name || appName(item.path || item.url || '');
  const fail = (m) => { console.error('[island] could not open', name, m); D.toast('Could not open ' + name, String(m).slice(0, 60), 'err'); };
  try {
    if (item.kind === 'url') { shell.openExternal(item.url).catch((e) => fail(e.message)); return; }
    if (item.kind === 'folder') { shell.openPath(item.path).then((err) => err && fail(err)); return; }
    if (/^shell:/i.test(item.path)) { spawn('explorer.exe', [item.path], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return; }
    shell.openPath(item.path).then((err) => err && fail(err));
  } catch (e) { fail(e.message); }
}

// installed applications (Start Menu shortcuts on Windows, .app bundles on the Mac), searched by name
let installed = { at: 0, list: [], uwp: [], uwpAt: 0, uwpLoading: null };
// Microsoft Store apps (WhatsApp, ...) have no Start Menu shortcut file: a small script lists them
function loadStoreApps() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (installed.uwpLoading) return installed.uwpLoading;
  installed.uwpLoading = new Promise((resolve) => {
    let out = '';
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'apps.ps1')], { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      try { installed.uwp = JSON.parse(out.trim() || '[]').map((a) => ({ name: a.name, path: 'shell:AppsFolder\\' + a.id, logo: a.logo || '', uwp: true })); } catch { installed.uwp = []; }
      installed.uwpAt = Date.now(); installed.uwpLoading = null; resolve(installed.uwp);
    });
  });
  return installed.uwpLoading;
}
const allInstalled = () => {
  const seen = new Set(), out = [];
  for (const a of [...installed.list, ...installed.uwp]) { const k = a.name.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(a); } }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};
function scanInstalled() {
  const out = new Map();
  const walk = (dir, depth, test) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (test(e, p)) { const name = appName(p); if (!/uninstall|readme|license|documentation|help|website|release notes/i.test(name) && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, path: p }); }
      else if (e.isDirectory() && depth > 0 && !(MAC && /\.app$/i.test(e.name))) walk(p, depth - 1, test);
    }
  };
  if (MAC) {
    const test = (e) => e.isDirectory() && /\.app$/i.test(e.name);
    for (const d of ['/Applications', '/System/Applications', '/System/Applications/Utilities', '/Applications/Utilities', path.join(os.homedir(), 'Applications')]) walk(d, 1, test);
    if (fs.existsSync('/System/Library/CoreServices/Finder.app')) out.set('finder', { name: 'Finder', path: '/System/Library/CoreServices/Finder.app' });
  } else {
    const test = (e) => e.isFile() && /\.lnk$/i.test(e.name);
    for (const d of [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')]) walk(d, 3, test);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function searchApps(query) {
  if (Date.now() - installed.at > 60000) { installed.at = Date.now(); installed.list = scanInstalled(); }
  if (!installed.uwpAt || Date.now() - installed.uwpAt > 300000) await Promise.race([loadStoreApps(), new Promise((res) => setTimeout(res, 9000))]);
  const q = String(query || '').trim().toLowerCase();
  const hits = allInstalled().filter((a) => !q || a.name.toLowerCase().includes(q));
  hits.sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1));
  const out = [];
  for (const a of hits.slice(0, 12)) out.push({ path: a.path, name: a.name, logo: a.logo || '', icon: await appIcon(a.path, a.logo) }); // one at a time
  return out;
}

// ---------------------------------------------------------------- the ring window
let pageStamp = 0;
const stamp = () => { try { return ['radial.html', 'assets/wheel.js'].map((f) => fs.statSync(path.join(__dirname, f)).mtimeMs).join('|'); } catch { return 0; } };
let idleTimer = null; // the wheel's window is thrown away a minute after it was last used (it holds about 100 MB while it waits) and made again when it is needed
const enabled = () => !D || D.store.get('radialOn', true) !== false;
function destroyWin() { if (win && !win.isDestroyed() && !isOpen) { win.destroy(); win = null; try { require('./lifecycle').line('radial menu: window released (not in use)'); } catch {} } }
function setEnabled(v) { D.store.set('radialOn', !!v); if (!v) { close(); destroyWin(); } }
let win = null, isOpen = false, timer = null, away = 0, heldBy = null, holdTimer = null, center = { x: 0, y: 0 }, current = null;

function close() {
  if (isOpen) { try { require('./lifecycle').line('radial menu closed'); } catch {} }
  clearInterval(timer); timer = null; clearInterval(holdTimer); holdTimer = null; isOpen = false; heldBy = null;
  try { globalShortcut.unregister('Escape'); } catch {}
  if (win && !win.isDestroyed()) win.hide();
  clearTimeout(idleTimer); idleTimer = setTimeout(destroyWin, 60000); idleTimer.unref();
}

async function payload(cfg) {
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64');
  const workspaces = {};
  for (const w of cfg.workspaces) {
    const items = [];
    for (let i = 0; i < w.items.length; i++) {
      const it = w.items[i];
      items.push({ kind: it.kind, label: it.name, icon: await itemIcon(it), ws: w.id, index: i });
    }
    workspaces[w.id] = { name: w.name, items };
  }
  const wsLogo = {};
  for (const w of cfg.workspaces) wsLogo[w.id] = await logoUrl(w.logo);
  const items = [];
  for (const it of cfg.items) items.push(it.type === 'action'
    ? { kind: 'action', action: it.action, label: ACTIONS[it.action], icon: await logoUrl(it.logo) }
    : { kind: 'workspace', ws: it.ws, label: (workspaces[it.ws] || {}).name || 'Workspace', count: ((workspaces[it.ws] || {}).items || []).length, icon: wsLogo[it.ws] || '' });
  return { cfg: { appearance: cfg.appearance, mode: cfg.mode, zone: cfg.zone }, logo, items, workspaces, colors: D.store.get('colors', []).slice(0, 5) };
}

async function open(trigger) {
  if (isOpen) { close(); return; }
  if (!enabled()) return; // switched off in Settings: nothing is created, nothing waits
  clearTimeout(idleTimer);
  try {
    const cfg = getCfg();
    const data = await payload(cfg);
    const maxN = Math.max(cfg.items.length, ...cfg.workspaces.map((w) => w.items.length), 3);
    const S = Wheel.size(maxN, cfg.appearance);
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: S, height: S, show: false, frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true,
        alwaysOnTop: true, focusable: false, enableLargerThanScreen: true, acceptFirstMouse: true, ...(MAC ? { type: 'panel' } : {}),
        webPreferences: { preload: path.join(__dirname, 'radial-preload.js'), contextIsolation: true },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      await win.loadFile(path.join(__dirname, 'radial.html'));
      pageStamp = stamp();
    } else if (pageStamp !== stamp()) { // the page files changed (an update): load them again
      await win.loadFile(path.join(__dirname, 'radial.html'));
      pageStamp = stamp();
    }
    const p = screen.getCursorScreenPoint(), d = screen.getDisplayNearestPoint(p).workArea;
    const x = Math.round(Math.min(Math.max(p.x - S / 2, d.x), d.x + d.width - S)), y = Math.round(Math.min(Math.max(p.y - S / 2, d.y), d.y + d.height - S));
    win.setBounds({ x, y, width: S, height: S });
    current = { cfg, workspaces: cfg.workspaces };
    win.webContents.send('radial-open', data);
    win.showInactive();
    isOpen = true; away = 0;
    try { require('./lifecycle').line(`radial menu opened (${data.items.length} items) by ${trigger}`); } catch {}
    center = { x: x + S / 2, y: y + S / 2 };
    const born = Date.now();
    try { globalShortcut.register('Escape', () => close()); } catch {}
    // hold mode: the wheel stays down while you point at an item; the page follows the pointer, release picks
    if (cfg.mode === 'hold' && trigger === 'middle') {
      heldBy = 'middle';
      holdTimer = setInterval(() => { const q = screen.getCursorScreenPoint(); if (win && !win.isDestroyed()) win.webContents.send('radial-cursor', { x: q.x - center.x, y: q.y - center.y }); }, 16);
    }
    timer = setInterval(() => {
      const q = screen.getCursorScreenPoint();
      away = Math.hypot(q.x - center.x, q.y - center.y) > S / 2 + 60 ? away + 1 : 0;
      if (away > 6 || Date.now() - born > (heldBy ? 30000 : 12000)) close();
    }, 100);
  } catch (e) { console.error('[island] radial menu failed:', e.message); close(); }
}

// ---------------------------------------------------------------- settings window (all settings, the radial menu is a part of it)
let settingsWin = null;
const front = () => {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  // the island is a non-activating window, so a new window would stay behind the others: bring it to the front explicitly
  if (MAC) { try { app.setActivationPolicy('regular'); app.dock.show(); } catch {} app.focus({ steal: true }); }
  if (MAC) { try { settingsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); setTimeout(() => { try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setVisibleOnAllWorkspaces(false); } catch {} }, 1500); settingsWin.moveTop(); } catch {} } // opens on the current Space, not on another one
  settingsWin.show(); settingsWin.focus();
  if (!MAC) { settingsWin.setAlwaysOnTop(true); settingsWin.setAlwaysOnTop(false); }
};
function openSettings(page) {
  console.log('[island] settings window requested', page || '');
  try { require('./lifecycle').line('settings window requested ' + (page || '')); } catch {}
  const q = page ? { query: { p: String(page) } } : undefined;
  if (settingsWin && !settingsWin.isDestroyed()) { if (page) settingsWin.loadFile(path.join(__dirname, 'settings.html'), q); front(); return; }
  settingsWin = new BrowserWindow({
    width: 940, height: 680, minWidth: 780, minHeight: 540, title: 'A-tuls - Settings', backgroundColor: '#141416', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: false },
  });
  settingsWin.setMenu(null);
  settingsWin.once('ready-to-show', front);
  // if the first frame never comes (the window was made while the system was busy or the pointer belonged to the other computer) it is shown anyway
  settingsWin.webContents.once('did-finish-load', () => setTimeout(() => { if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.isVisible()) { try { require('./lifecycle').line('settings window shown after load (no first frame)'); } catch {} front(); } }, 400));
  setTimeout(() => { if (settingsWin && !settingsWin.isDestroyed() && !settingsWin.isVisible()) { try { require('./lifecycle').line('settings window shown after 3 s'); } catch {} front(); } }, 3000).unref();
  settingsWin.webContents.on('did-fail-load', (_e, c, d) => { console.error('[island] settings page failed to load', c, d); try { require('./lifecycle').line('settings page failed to load: ' + c + ' ' + d); } catch {} });
  settingsWin.webContents.on('render-process-gone', (_e, d) => { try { require('./lifecycle').line('settings renderer gone: ' + d.reason); } catch {} });
  settingsWin.webContents.on('preload-error', (_e, p, err) => { console.error('[island] settings preload error', p, err && err.message); try { require('./lifecycle').line('settings preload error: ' + (err && err.message)); } catch {} });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'), q);
  settingsWin.on('closed', () => { settingsWin = null; if (MAC) { try { app.setActivationPolicy('accessory'); app.dock.hide(); } catch {} } });
}
const sendSettings = (ch, ...a) => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(ch, ...a); };

function currentTrigger() {
  const m = D.link.buttonMap || {};
  return m.middle === 'radial' ? 'middle' : m.forward === 'radial' ? 'forward' : m.back === 'radial' ? 'back' : 'off';
}

function init(deps) {
  D = deps;
  const { link, store } = D;
  link.on('radial', (trigger) => open(trigger));
  link.on('middle-up', () => { if (isOpen && heldBy === 'middle' && win && !win.isDestroyed()) win.webContents.send('radial-release'); });

  ipcMain.on('radial-close', () => close());
  ipcMain.on('radial-color', (_e, v) => { close(); if (/^#[0-9A-F]{6}$/i.test(v)) D.saveColor(v.toUpperCase()); });
  ipcMain.on('radial-action', (_e, action) => {
    close();
    try { require('./lifecycle').line('radial menu: action ' + action); } catch {}
    if (!ACTIONS[action]) return;
    setTimeout(() => { try { if (action === 'pickColor') D.pickColor(); else link.runAction(action, 'radial', 0); } catch (e) { console.error('[island] radial action failed:', e.message); } }, 120);
  });
  ipcMain.on('radial-run', (_e, ref) => {
    close();
    const w = getCfg().workspaces.find((x) => x.id === (ref && ref.ws));
    const it = w && w.items[ref.index];
    if (it) { try { require('./lifecycle').line(`radial menu: open ${it.kind} "${it.name}"`); } catch {} launch(it); }
  });

  // settings window
  ipcMain.on('rs:open', () => openSettings('activation'));
  ipcMain.on('settings:open', (_e, page) => openSettings(page));
  ipcMain.handle('rs:load', async () => {
    const cfg = getCfg();
    const icons = {};
    for (const w of cfg.workspaces) for (const it of w.items) if (it.kind === 'app' && icons[it.path] === undefined) icons[it.path] = await appIcon(it.path, it.logo);
    return { cfg, icons, trigger: currentTrigger(), actions: Object.entries(ACTIONS).map(([id, label]) => ({ id, label })), limit: LIMIT, mac: MAC };
  });
  ipcMain.handle('rs:save', (_e, c) => { const v = setCfg(c); try { require('./lifecycle').line(`settings: radial menu saved (${v.items.length} ring items, ${v.workspaces.length} workspaces, ${v.workspaces.reduce((n, w) => n + w.items.length, 0)} shortcuts, radius ${v.appearance.radius}, icon ${v.appearance.icon}, spacing ${v.appearance.spacing})`); } catch {} return v; });
  ipcMain.handle('rs:trigger', (_e, k) => {
    const map = { ...(link.buttonMap || {}) };
    for (const key of ['middle', 'back', 'forward']) if (map[key] === 'radial') map[key] = 'default';
    if (['middle', 'back', 'forward'].includes(k)) map[k] = 'radial';
    link.buttonMap = map; store.set('buttonMap', map);
    try { require('./lifecycle').line('settings: radial trigger ' + currentTrigger()); } catch {}
    return currentTrigger();
  });
  ipcMain.handle('rs:search', (_e, q) => searchApps(q));
  ipcMain.handle('rs:icon', (_e, p, logo) => appIcon(String(p), logo));
  ipcMain.handle('rs:itemicon', (_e, it) => itemIcon(it && typeof it === 'object' ? { kind: it.kind, path: String(it.path || ''), url: String(it.url || ''), logo: String(it.logo || '') } : null));
  ipcMain.handle('rs:pickicon', async () => {
    const r = await dialog.showOpenDialog(settingsWin || undefined, { title: 'Choose an icon', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'ico', 'bmp', 'gif'] }] });
    return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
  });
  ipcMain.handle('rs:folder', async () => {
    const r = await dialog.showOpenDialog(settingsWin || undefined, { title: 'Choose a folder', properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : { path: r.filePaths[0], name: path.basename(r.filePaths[0]) || r.filePaths[0] };
  });
  ipcMain.handle('rs:test', () => { open('test'); });

  setTimeout(() => loadStoreApps(), 6000); // so the first search is instant
}

const evalSettings = (code) => (settingsWin && !settingsWin.isDestroyed() ? settingsWin.webContents.executeJavaScript(code) : Promise.resolve('no settings window')); // development tests
module.exports = { evalSettings, itemIcon, init, open, close, setEnabled, openSettings, sendSettings, get isOpen() { return isOpen; } };
