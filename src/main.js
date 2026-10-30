const { session, powerMonitor, app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu, nativeImage, clipboard, ClipboardItem, systemPreferences, safeStorage } = require('electron');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const input = require('./input');
const native = require('./native');
const { Diag } = require('./diag');
const { Link } = require('./link');
const HK = require('./hotkeys');
const KEY_NAMES = Object.keys(require('uiohook-napi').UiohookKey);
const { Calibrator, ZoneTracker } = require('./gaze');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { WaNotifier } = require('./notify');
const { Water } = require('./water');
const { WaConnect } = require('./wa-connect');
const usage = require('./usage');
// which data folder this run uses (and whether another A-tuls is really running): decided before the settings are read
const instance = require('./instance').claim(app);

const MAC = process.platform === 'darwin';
// both platforms: a pill at the top edge, centred (on a notched MacBook it is long, with an empty middle for the notch)
// Windows: the window is resized to exactly the island, so no click-through trick is needed (it broke drag & drop)
const WIN_W = MAC ? 464 : 234, WIN_H = 34;
// Windows: the window keeps one size and only its visible/clickable shape follows the island. Resizing a transparent window
// made the pill blink for a frame on every hover; reshaping does not.
const WIN_FIXED = { w: 660, h: 460 };

// tiny JSON store in userData
const store = (() => {
  const file = path.join(app.getPath('userData'), 'config.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; try { fs.writeFileSync(file, JSON.stringify(data)); } catch {} },
  };
})();

// The pairing tokens let another computer drive this one, so on disk they are encrypted with the system's own protection (Windows DPAPI,
// the macOS Keychain) instead of lying in config.json as plain text. Old plain values are sealed the first time they are read. macOS
// only does this in the installed app: a development run would ask for Keychain access each time.
const SECRET_KEYS = new Set(['tokens', 'peers', 'peerTokens', 'calendars', 'waLog']); // (waLog: the WhatsApp messages listed on the island)
function protectedStore(base) {
  const canSeal = () => { try { return (process.platform === 'win32' || app.isPackaged) && safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const seal = (v) => ({ enc: safeStorage.encryptString(JSON.stringify(v)).toString('base64') });
  return {
    get(k, d) {
      const v = base.get(k, undefined);
      if (v === undefined) return d;
      if (!SECRET_KEYS.has(k)) return v;
      if (v && typeof v === 'object' && typeof v.enc === 'string') { try { return JSON.parse(safeStorage.decryptString(Buffer.from(v.enc, 'base64'))); } catch { return d; } }
      if (canSeal()) { try { base.set(k, seal(v)); } catch {} }
      return v;
    },
    set(k, v) { if (SECRET_KEYS.has(k) && canSeal()) { try { return base.set(k, seal(v)); } catch {} } return base.set(k, v); },
    sealed: () => canSeal(),
  };
}

// every screen: input pixels (what the mouse hook reports) plus device-independent points
// The shared layout plane is in millimetres, so screens of different computers keep their real relative size.
// dx/dy/dw/dh are millimetres; x/y/w/h stay input pixels; mpp is millimetres per input pixel.
let physical = null; // cached sizes from the monitors themselves
function refreshPhysicalSizes() {
  const list = screen.getAllDisplays().map((d) => {
    const phys = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    return { x: phys.x, y: phys.y, w: phys.width, h: phys.height };
  });
  let mm = list.map(() => null);
  if (process.platform === 'darwin') {
    const known = native.macDisplaySizes();
    mm = list.map((d) => known.find((k) => Math.abs(k.x - d.x) < 2 && Math.abs(k.y - d.y) < 2 && Math.abs(k.w - d.w) < 2) || null);
  } else if (process.platform === 'win32') {
    mm = native.matchSizes(list, native.winMonitorSizes());
    native.refreshWinMonitorSizes(() => { physical = null; settleDisplays(); }); // a fresh answer from the monitors arrives in the background
  }
  physical = mm;
}
function displaysList() {
  if (!physical || physical.length !== screen.getAllDisplays().length) refreshPhysicalSizes();
  const raw = screen.getAllDisplays().map((d, i) => {
    const phys = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
    const dipW = d.bounds.width;
    const known = physical[i];
    // without a size from the monitor, assume the usual 96 pixels per inch
    return { x: phys.x, y: phys.y, w: phys.width, h: phys.height, dip: d.bounds, mmw: known ? known.mmw : dipW * 0.2646, mmh: known ? known.mmh : d.bounds.height * 0.2646 };
  });
  // one millimetres-per-DIP scale for the whole computer keeps neighbouring screens exactly adjacent
  const s = raw.reduce((a, r) => a + r.mmw, 0) / raw.reduce((a, r) => a + r.dip.width, 0);
  return raw.map((r) => ({
    x: r.x, y: r.y, w: r.w, h: r.h,
    dx: r.dip.x * s, dy: r.dip.y * s, dw: r.dip.width * s, dh: r.dip.height * s,
    mmw: r.mmw, mmh: r.mmh, mpp: (r.dip.width * s) / r.w, s,
  }));
}

// the overlay has to cover all screens, not just the primary one
function desktopBounds() {
  const ds = screen.getAllDisplays().map((d) => d.bounds);
  const x0 = Math.min(...ds.map((b) => b.x)), y0 = Math.min(...ds.map((b) => b.y));
  const x1 = Math.max(...ds.map((b) => b.x + b.width)), y1 = Math.max(...ds.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const primarySize = () => {
  const d = screen.getPrimaryDisplay();
  // Windows hooks report physical pixels; macOS reports points
  const k = process.platform === 'win32' ? d.scaleFactor : 1;
  return { w: Math.round(d.bounds.width * k), h: Math.round(d.bounds.height * k) };
};

// macOS: the network utility process crashed on the test machine and the page never loaded
if (process.platform === 'darwin') {
  // (hardware acceleration used to be switched off here too, but then WebGL does not exist and the head tracking, which reads the camera through
  // WebGL, fails on every frame)
  app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');
}
app.on('child-process-gone', (_e, d) => console.error('[island] child process gone:', d.type, d.reason, d.exitCode, d.name || ''));

const lifecycle = require('./lifecycle');
lifecycle.init(); // island-run.log: start, quit requests (with who asked), crashes and a clean-shutdown verdict
let win, link, overlay, tray, lastHide = 0, diag;
// One line a minute for a long test: memory, CPU, link state, camera, how long the hooks were silent. Cheap, and it shows slow leaks or a
// stuck state days later without having to be there when it happens.
setInterval(() => {
  try {
    const m = app.getAppMetrics(); const cpu = m.reduce((a, p) => a + (p.cpu.percentCPUUsage || 0), 0), mem = m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) / 1024;
    lifecycle.line(`health: cpu ${cpu.toFixed(1)}% mem ${Math.round(mem)} MB procs ${m.length} link ${link ? link.state + (link.sock ? ' linked' : ' alone') : '-'} camera ${typeof gazeWin !== 'undefined' && gazeWin ? 'on' : 'off'} up ${Math.round(process.uptime() / 60)} min`);
  } catch {}
}, 60000).unref();
const MIRRORED = new Set(['gaze', 'colors', 'perm', 'update', 'cal', 'look']); // the settings window shows these as well
let lastMedia = null; // the page asks for nothing: when it (re)loads it is given what is playing right away
const sendWin = (ch, ...a) => { if (ch === 'media') lastMedia = a[0] && a[0].title ? a[0] : null; if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); if (MIRRORED.has(ch)) radial.sendSettings(ch, ...a); };
// short banner that grows out of the pill for a few seconds
let toastUntil = 0;
// the volume (0-100) a notice is played at; 0 = silent (switched off, or the pill is hidden in a game)
const soundVol = () => (store.get('sound', true) && win && !win.isDestroyed() && win.isVisible() ? Math.max(0, Math.min(100, Number(store.get('soundVol', 60)))) : 0);
function toast(title, text, kind = 'ok', extra = {}) {
  toastUntil = Date.now() + 5000;
  sendWin('toast', { title, text, kind, ...extra, sound: soundVol() });
}

// height of the menu bar strip (notched MacBooks have a taller one); the Mac pill is exactly that tall
// Left edge of the pill window for a window w wide. Centre: in the middle of the screen. Right: on Windows toward the right side; on a Mac the
// pill starts just right of the camera notch (so it sits next to the menu bar icons instead of on top of them), and the open panel grows
// to the right from the same edge.
const NOTCH_HALF = 105, NOTCH_GAP = 12;
const pillLeft = (w) => {
  const b = screen.getPrimaryDisplay().bounds;
  if (store.get('pillPos', 'center') !== 'right') return Math.round(b.x + b.width / 2 - w / 2);
  if (MAC) return Math.round(Math.min(b.x + b.width / 2 + NOTCH_HALF + NOTCH_GAP, b.x + b.width - w - 4));
  return Math.round(b.x + b.width - 24 - 312 - w / 2);
};
function placeWindow() { if (!win || win.isDestroyed()) return; const b = win.getBounds(); win.setBounds({ x: pillLeft(b.width), y: b.y, width: b.width, height: b.height }); }
// ---- tones (the same tunes as the page's synthesizer in renderer/app.js): [frequency Hz, start s, length s, wave]
const TUNES = {
  ok: [[880, 0, 0.09], [1318, 0.09, 0.16]],
  sent: [[587, 0, 0.08], [880, 0.08, 0.08], [1175, 0.16, 0.18]],
  received: [[1175, 0, 0.1], [880, 0.1, 0.1], [659, 0.2, 0.22]],
  connected: [[523, 0, 0.09], [659, 0.09, 0.09], [784, 0.18, 0.09], [1047, 0.27, 0.26]],
  err: [[330, 0, 0.14, 'triangle'], [247, 0.17, 0.26, 'triangle']],
  shot: [[2400, 0, 0.03, 'square'], [1500, 0.035, 0.07, 'sine']],
  impact: [[95, 0, 0.14, 'sine'], [58, 0.015, 0.2, 'sine'], [1900, 0, 0.012, 'square']],
  start: [[196, 0, 0.7, 'triangle'], [392, 0.02, 0.14], [523, 0.14, 0.14], [659, 0.26, 0.14], [784, 0.38, 0.16], [1047, 0.52, 0.6]],
  chat: [[1047, 0, 0.07], [1397, 0.08, 0.12]],
  water: [[784, 0, 0.12], [988, 0.14, 0.12], [1319, 0.28, 0.12], [1568, 0.42, 0.3]],
};
function toneFile(kind) {
  const file = path.join(app.getPath('userData'), 'tones', kind + '.wav');
  if (fs.existsSync(file)) return file;
  const rate = 22050, tune = TUNES[kind] || TUNES.ok;
  const n = Math.ceil(Math.max(...tune.map(([, at, len]) => at + len + 0.12)) * rate), mix = new Float32Array(n);
  for (const [freq, at, len, wave] of tune) {
    const s0 = Math.floor(at * rate), dur = len + 0.06, s1 = Math.min(n, Math.floor((at + dur) * rate));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / rate, ph = 2 * Math.PI * freq * t;
      const w = wave === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : wave === 'square' ? (Math.sin(ph) >= 0 ? 0.5 : -0.5) : Math.sin(ph);
      mix[i] += w * Math.min(1, t / 0.012) * Math.pow(0.002, t / dur);
    }
  }
  let peak = 0.001; for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round((mix[i] / peak) * 0.9 * 32767), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pcm);
  return file;
}
function playToneMac(kind, vol) {
  if (!MAC || !(vol > 0)) return;
  try { require('child_process').execFile('/usr/bin/afplay', ['-v', String(Math.min(1, Math.pow(vol / 100, 1.3) * 1.2)), toneFile(kind)], () => {}); } catch (e) { lifecycle.line('tone failed: ' + e.message); }
}
const barH = () => { if (!MAC) return 34; const d = screen.getPrimaryDisplay(); return Math.max(24, d.workArea.y - d.bounds.y); };

function shapeWindow(w, h) {
  const W = WIN_FIXED.w, H = WIN_FIXED.h;
  w = Math.min(W, Math.max(1, Math.round(w))); h = Math.min(H, Math.max(1, Math.round(h)));
  try { win.setShape([{ x: Math.round((W - w) / 2), y: 0, width: w, height: h }]); } catch (e) { console.error('[island] setShape failed:', e.message); }
}

function createWindow() {
  const { x, width } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x: pillLeft(MAC ? WIN_W : WIN_FIXED.w), y: 0, width: MAC ? WIN_W : WIN_FIXED.w, height: MAC ? barH() : WIN_FIXED.h,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, enableLargerThanScreen: true, acceptFirstMouse: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    ...(MAC ? { type: 'panel' } : {}), // non-activating panel: accepts drops without stealing focus
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!MAC) { shapeWindow(WIN_W, WIN_H); win.setIgnoreMouseEvents(true); } // the small pill lets clicks through (the panel takes them while open)
  win.webContents.on('did-finish-load', () => { if (lastMedia) setTimeout(() => { try { win.webContents.send('media', lastMedia); } catch {} }, 150); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const revealAt = Date.now() + splash.play({ enabled: store.get('splash', true), pillCenterY: barH() / 2, colors: store.get('splashColors', {}) });
  win.webContents.once('did-finish-load', () => setTimeout(() => { if (store.get('sound', true)) sendWin('chime', { kind: 'start', vol: Math.max(0, Math.min(100, Number(store.get('soundVol', 60)))) }); }, 200));
  const reveal = () => { if (win.isVisible()) return; if (revealAt > Date.now()) { setTimeout(reveal, revealAt - Date.now()); return; } win.showInactive(); if (process.platform === 'darwin') win.setPosition(win.getPosition()[0], 0); console.log('[island] window shown at', JSON.stringify(win.getBounds())); };
  win.once('ready-to-show', reveal);
  win.webContents.on('did-finish-load', () => { console.log('[island] page loaded'); setTimeout(reveal, 300); });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[island] renderer gone:', d.reason, d.exitCode));
  setTimeout(() => { if (!win.isVisible()) { console.log('[island] page not loaded after 5s, showing anyway'); win.showInactive(); } }, 5000);
  win.webContents.on('did-fail-load', (_e, c, d) => console.error('[island] load failed', c, d));
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
}

// While this computer is controlling the other one, a near-invisible fullscreen
// window swallows local clicks, scrolling and keystrokes so nothing happens here.
function createOverlay() {
  overlay = new BrowserWindow({
    frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'overlay-preload.js'), contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  // keys are forwarded from the global hook; the focused overlay just swallows them locally
  overlay.webContents.on('before-input-event', (e, input) => {
    e.preventDefault();
    if (input.type === 'keyDown' || input.type === 'keyUp') link.onOverlayKey(input.type === 'keyDown', input.code);
  });
}

function setCapture(on) {
  // on Windows the native hooks swallow local input, so no overlay window is needed (it also darkened playing video)
  if (link.external) {
    native.setCursorHidden(on);
    if (!on && process.platform === 'win32') input.releaseLocalModifiers();
    return;
  }
  if (process.platform === 'darwin') native.macMouse.hideCursor(on); // the overlay only hides it while it has focus
  if (!overlay && on && !MAC) createOverlay();
  if (!overlay) return;
  if (!on) {
    overlay.webContents.executeJavaScript('document.exitPointerLock && document.exitPointerLock()', true).catch(() => {});
    link.locked = false;
    overlay.hide();
    if (process.platform === 'win32') input.releaseLocalModifiers();
    return;
  }
  overlay.setBounds(desktopBounds());
  overlay.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  overlay.focus();
  // lock the pointer so it stays frozen (and hidden) here while the other computer moves
  setTimeout(() => overlay.webContents.executeJavaScript('document.body.requestPointerLock()', true).catch(() => {}), 40);
  // if the OS refused to give us keyboard focus, click once on the overlay (buttons are muted for a moment)
  setTimeout(() => { if (overlay.isVisible() && !overlay.isFocused()) input.click(); }, 120);
}

// hover is polled from the cursor position so it also works while dragging files in from the OS
let islandSize = { w: 170, h: 34 }, hoverNow = false;
// Windows: the small pill lets clicks through to the window under it (a browser tab, for example), so the panel opens only when the pointer
// rests on the pill for a moment, and not at all when the pointer clicks there.
const HOVER_DWELL = 380;
let hoverSince = 0, hoverClicked = false, hoverEnteredDown = false;
function pollHover() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint(), b = win.getBounds();
    const w = islandSize.w + 8, h = islandSize.h + 8, x0 = pillLeft(islandSize.w) - 4;
    const inside = p.x >= x0 && p.x <= x0 + w && p.y >= b.y && p.y <= b.y + h;
    if (!inside) { hoverSince = 0; hoverClicked = false; }
    else if (!hoverNow && !MAC) {
      const down = native.winLeftDown();
      if (!hoverSince) { hoverSince = Date.now(); hoverEnteredDown = down; } // a button already down on the way in = a file being dragged in
      if (down && !hoverEnteredDown) hoverClicked = true;
      if (hoverClicked || Date.now() - hoverSince < HOVER_DWELL) return;
    }
    if (inside === hoverNow) return;
    hoverNow = inside;
    win.webContents.send('hover', inside);
  }, 60);
}

// "Click" mode (Settings > General > Show the island): the panel opens with a click on the pill instead of when the pointer rests on it. The small pill
// lets clicks through to the window under it on Windows, so the click is read from the input hook.
function pillClickCheck(button) {
  if (button !== 1 || store.get('openMode', 'hover') !== 'click' || !win || win.isDestroyed() || !win.isVisible() || islandSize.h > 100) return;
  if (link && (link.state === 'controlling' || link.lockedOut())) return;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  const w = islandSize.w + 8, h = islandSize.h + 8, x0 = pillLeft(islandSize.w) - 4;
  if (p.x >= x0 && p.x <= x0 + w && p.y >= b.y && p.y <= b.y + h) win.webContents.send('pill-click');
}

// the pill hides itself in games and full-screen programs (and by hand: tray menu, Ctrl+Alt+H)
let gameHide = false, pillOff = false;
function applyPillVisible() {
  if (!win || win.isDestroyed()) return;
  const hide = gameHide || pillOff;
  if (hide && win.isVisible()) { hoverNow = false; try { win.webContents.send('hover', false); } catch {} win.hide(); }
  else if (!hide && !win.isVisible()) win.showInactive();
}
let lastSwitchAt = 0;
function watchGames() {
  if (MAC) return;
  let last = false, gameSeen = 0;
  setInterval(() => {
    const st = native.winUserState();
    let game = store.get('gameHide', true) && (st === 2 || st === 3 || st === 4) && Date.now() - lastSwitchAt > 5000; // the edge effect of a pointer arriving is a full-screen window for a moment
    if (game && !last && ++gameSeen < 2) return; // a game must be seen twice in a row (3 s) before the pill hides
    if (!game) gameSeen = 0;
    if (game === last) return;
    last = game; gameHide = game; if (link) link.gameActive = game; // the wheel button, side buttons and the radial menu belong to the game then
    lifecycle.line('pill ' + (game ? 'hidden: a game or full-screen program is in front (state ' + st + ')' : 'shown again'));
    applyPillVisible();
  }, 1500).unref();
}
function togglePill() {
  pillOff = !pillOff; store.set('pillOff', pillOff);
  lifecycle.line('pill ' + (pillOff ? 'hidden by hand' : 'shown by hand'));
  applyPillVisible();
}

// macOS: a file dragged onto the island is recognised natively (the drag pasteboard + the mouse button), because the panel window
// does not always receive the drop itself. The renderer decides which tile the pointer is over.
function pollMacDrop() {
  if (!MAC) return;
  let wasDown = false, base = null, dragFiles = null, announced = false;
  // asked every 40 ms while the left button is down (a drag may be under way) and every 100 ms otherwise
  const tick = () => {
    try {
      if (!win || win.isDestroyed()) return;
      const down = native.macMouse.leftDown();
      if (down && !wasDown) { const b = native.macDragFiles(); base = b ? b.count : null; dragFiles = null; announced = false; }
      if (down && base !== null) {
        const b = native.macDragFiles();
        if (b && b.count !== base && b.files.length) {
          dragFiles = b.files;
          if (!announced) { announced = true; console.log('[island] file drag detected', b.files.length); win.setAlwaysOnTop(true, 'pop-up-menu'); sendWin('drag-start'); }
        }
      }
      if (!down && wasDown && dragFiles) {
        const p = screen.getCursorScreenPoint(), b = win.getBounds();
        const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height && b.height > 100;
        console.log('[island] file drag released', inside ? 'on the island' : 'elsewhere', JSON.stringify(p));
        if (inside) sendWin('native-drop', dragFiles, p.x - b.x, p.y - b.y);
        dragFiles = null; announced = false;
      }
      if (!down && wasDown) win.setAlwaysOnTop(true, 'screen-saver'); // back above everything once the mouse button is up
      wasDown = down;
    } catch (e) { console.error('[island] drop poll failed:', e.message); }
    setTimeout(tick, wasDown ? 40 : 100).unref();
  };
  setTimeout(tick, 100).unref();
}

// Color picker (live, like PowerToys): the screen keeps running; a small magnifier follows the pointer with the color under it,
// and the next click copies it as #RRGGBB. The click never reaches the app below (it is swallowed by the input hook).
let loupeWin = null, picking = false, pickFinish = null, pickTimer = null, pickGuard = null;
function closePicker() {
  if (process.platform === 'win32') native.setCrossCursor(false); // the normal pointer shapes come back
  clearInterval(pickTimer); pickTimer = null; clearTimeout(pickGuard); pickGuard = null;
  try { require('electron').globalShortcut.unregister('Escape'); } catch {}
  if (link) link.picker = null;
  if (loupeWin && !loupeWin.isDestroyed()) loupeWin.destroy();
  loupeWin = null;
}
function saveColor(v) {
  clipboard.writeText(v);
  const list = [v, ...store.get('colors', []).filter((c) => c !== v)].slice(0, 12);
  store.set('colors', list);
  sendWin('colors', list);
  toast('Copied ' + v, 'Color is in your clipboard', 'ok');
  console.log('[island] color picked', v);
}
// macOS: the system's own color sampler (the same one Digital Color Meter uses, reached through the web EyeDropper). It shows a live
// magnifier and needs NO Screen Recording permission, so there is no permission prompt at all.
let sysPickWin = null;
async function pickColorMac() {
  if (picking) { console.log('[island] picker: requested (already running, ignored)'); return; }
  picking = true;
  console.log('[island] picker: requested (system color sampler)');
  const guard = setTimeout(() => { try { sysPickWin && !sysPickWin.isDestroyed() && sysPickWin.destroy(); } catch {} }, 60000);
  try {
    sysPickWin = new BrowserWindow({ x: -300, y: -300, width: 120, height: 120, show: false, frame: false, skipTaskbar: true, focusable: true, webPreferences: { contextIsolation: true } });
    await sysPickWin.loadFile(path.join(__dirname, 'eyedropper.html')); // EyeDropper needs a secure context (a file page is one)
    sysPickWin.show();
    app.focus({ steal: true });
    sysPickWin.focus();
    const hex = await sysPickWin.webContents.executeJavaScript("new EyeDropper().open().then((r) => r.sRGBHex).catch(() => null)", true);
    if (hex) saveColor(String(hex).toUpperCase()); else console.log('[island] picker: cancelled');
  } catch (e) {
    console.error('[island] color picker failed:', e.message);
    toast('Color picker failed', String(e.message).slice(0, 70), 'err');
  }
  clearTimeout(guard);
  try { sysPickWin && !sysPickWin.isDestroyed() && sysPickWin.destroy(); } catch {}
  sysPickWin = null; picking = false;
}
async function pickColor() {
  if (MAC) return pickColorMac();
  console.log('[island] picker: requested' + (picking ? ' (already running, ignored)' : ''));
  if (picking) return;
  picking = true;
  let current = null, frames = 0;
  const done = (hex) => {
    const was = picking;
    closePicker(); picking = false; pickFinish = null;
    if (was && hex) saveColor(hex);
  };
  pickFinish = done;
  try {
    const W = 130, H = 160;
    loupeWin = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: true, resizable: false, hasShadow: false, skipTaskbar: true, alwaysOnTop: true,
      focusable: false, enableLargerThanScreen: true, ...(MAC ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(__dirname, 'loupe-preload.js'), contextIsolation: true },
    });
    loupeWin.setAlwaysOnTop(true, 'screen-saver');
    loupeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    loupeWin.setIgnoreMouseEvents(true); // clicks go to the input hook (below), not to this window
    await loupeWin.loadFile(path.join(__dirname, 'loupe.html'));
    const sample = () => {
      if (!loupeWin || loupeWin.isDestroyed()) return;
      const dip = screen.getCursorScreenPoint();
      const phys = MAC ? dip : (native.winCursor.get() || screen.dipToScreenPoint(dip));
      const grid = native.screenPixels(phys.x, phys.y, 11);
      if (!grid) { if (++frames === 3) { console.error('[island] picker: could not read the screen'); done(null); toast('Color picker failed', MAC ? 'Allow Screen Recording for this app' : 'Could not read the screen', 'err'); } return; }
      const c = 5 * 11 + 5;
      current = '#' + [grid[c * 3], grid[c * 3 + 1], grid[c * 3 + 2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      loupeWin.webContents.send('loupe-frame', { grid: Array.from(grid), text: current });
      const d = screen.getDisplayNearestPoint(dip).workArea;
      let x = dip.x + 22, y = dip.y + 22;
      if (x + W > d.x + d.width) x = dip.x - W - 14;
      if (y + H > d.y + d.height) y = dip.y - H - 14;
      loupeWin.setPosition(Math.round(x), Math.round(y), false);
      if (!loupeWin.isVisible()) loupeWin.showInactive();
    };
    link.picker = { pick: () => { if (current) done(current); }, cancel: () => done(null) };
    try { require('electron').globalShortcut.register('Escape', () => done(null)); } catch {}
    pickTimer = setInterval(sample, 16);
    pickGuard = setTimeout(() => done(null), 60000); // failsafe
    console.log('[island] picker: live');
    if (process.platform === 'win32') native.setCrossCursor(true); // the pointer looks like a crosshair while the picker is live
  } catch (e) {
    console.error('[island] color picker failed:', e.message);
    closePicker(); picking = false; pickFinish = null;
    toast('Color picker failed', String(e.message).slice(0, 70), 'err');
  }
}

const radial = require('./radial'); // the radial menu and its settings window
const splash = require('./splash'); // start-up animation
const edgefx = require('./edgefx');
edgefx.setColorSource(() => store.get('splashColors', {})); // light effect on the screen edges when control moves between computers

// macOS: what is playing, for every player (a browser tab on YouTube, Spotify, Music ...), the same as Windows shows. macOS 15.4 and
// later keep the "now playing" information from ordinary programs; the adapter in src/vendor/mediaremote works around that by running
// through /usr/bin/perl, which Apple allows to use it (BSD licence, see the folder). It streams a JSON line on every change.
const MR_DIR = path.join(__dirname, 'vendor', 'mediaremote');
const MR_ARGS = (...extra) => [path.join(MR_DIR, 'mediaremote-adapter.pl'), path.join(MR_DIR, 'MediaRemoteAdapter.framework'), ...extra];
let mrChild = null, mrStopped = false;
function pollMediaMac() {
  const { spawn: sp } = require('child_process');
  let buf = '', last = '', fails = 0, born = 0;
  const start = () => {
    if (mrStopped) return;
    born = Date.now();
    const c = mrChild = sp('/usr/bin/perl', MR_ARGS('stream', '--no-diff', '--debounce=200'), { stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!lineText) continue;
        try {
          const p = (JSON.parse(lineText) || {}).payload || {};
          if (p.title && mediaBlocked(p.title, p.artist || '', p.bundleIdentifier || '')) continue; // a page the user does not want as music: what shows now stays
          if (!p.title) { if (last) { last = ''; lifecycle.line('media (mac): nothing playing'); } sendWin('media', {}); continue; }
          const thumb = p.artworkData ? `data:${p.artworkMimeType || 'image/jpeg'};base64,${p.artworkData}` : '';
          const key = `${p.bundleIdentifier} ${p.playing ? 'playing' : 'paused'}: ${p.title} - ${p.artist || ''}`;
          if (key !== last) { last = key; lifecycle.line('media (mac): ' + key + (thumb ? ' (cover)' : ' (no cover yet)')); }
          const rate = Number(p.playbackRate) || (p.playing ? 1 : 0), t0 = Date.parse(p.timestamp) || Date.now();
          const pos = Number.isFinite(Number(p.elapsedTime)) ? Number(p.elapsedTime) + (p.playing ? Math.max(0, (Date.now() - t0) / 1000) * rate : 0) : undefined;
          sendWin('media', { title: p.title, artist: p.artist || '', status: p.playing ? 'Playing' : 'Paused', thumb, pos: pos === undefined ? undefined : Math.round(pos * 100) / 100, end: Number(p.duration) > 0 ? Math.round(Number(p.duration) * 10) / 10 : 0 });
        } catch (e) { /* a partial line; the next one is complete */ }
      }
    });
    c.stderr.on('data', (d) => { const s = String(d).trim(); if (s) lifecycle.line('media (mac) adapter: ' + s.slice(0, 200)); });
    c.on('error', (e) => lifecycle.line('media (mac): adapter could not start: ' + e.message));
    c.on('close', (code) => {
      mrChild = null;
      if (mrStopped) return;
      fails = Date.now() - born < 5000 ? fails + 1 : 0;
      lifecycle.line(`media (mac): adapter ended (${code}); restarting`);
      if (fails < 6) setTimeout(start, Math.min(30000, 1000 * (fails + 1) * 2));
      else lifecycle.line('media (mac): adapter keeps failing, giving up (the play buttons still work)');
    });
  };
  start();
}
// the buttons: the adapter talks to whatever player owns "now playing"; the system media keys are the fallback
function macMediaCommand(k) {
  const id = { play: 2, next: 4, prev: 5 }[k];
  if (id === undefined) return;
  require('child_process').execFile('/usr/bin/perl', MR_ARGS('send', String(id)), { timeout: 5000 }, (err) => {
    if (err) { lifecycle.line('media (mac): send failed (' + err.message.slice(0, 80) + '), using the media key instead'); native.macMediaKey(k); }
  });
}

// Windows: one long-lived PowerShell answers a poll (one line in, one JSON line out). Starting a new PowerShell every 3 seconds cost about
// 0.4 s of CPU each time, roughly 1% of the whole computer, and none of it showed in A-tuls's own processes.
const mediaBlockList = () => (store.get('mediaBlock', []) || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
const mediaBlocked = (...texts) => { const hay = texts.join(' ').toLowerCase(); return mediaBlockList().some((w) => hay.includes(w)); };
let mediaChild = null, mediaSend = null, syncOutFn = () => {}, syncTest = () => 'no sync';
function mediaStop() { try { if (mediaChild) mediaChild.kill(); } catch {} mediaChild = null; }
let screenLocked = false;
let fakeMediaUntil = 0; // development tests only (control.cmd: fakemedia)
function pollMedia() {
  if (process.platform === 'darwin') return pollMediaMac();
  if (process.platform !== 'win32') return;
  const script = path.join(__dirname, 'media.ps1');
  let lastThumb = '', buf = '', waiting = false, timer = null, hasMedia = false, lastStatus = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(tick, lastStatus === 'Playing' ? 2000 : hasMedia ? 3000 : 6000); }; // nothing playing: ask less often
  const handle = (line) => {
    waiting = false;
    if (Date.now() < fakeMediaUntil) return schedule(); // a test is playing a made-up song
    try {
      const info = JSON.parse(line);
      if (info.blocked) return schedule(); // only an ignored page (Instagram, TikTok...) plays: the music that was showing stays as it is
      hasMedia = info.title !== undefined;
      if (info.status !== lastStatus) { lastStatus = info.status; lifecycle.line('media: ' + (info.title ? info.status + ' (previous track ' + (info.canPrev ? 'yes' : 'no') + ', next ' + (info.canNext ? 'yes' : 'no') + ')' : 'nothing playing')); }
      if (info.key !== undefined) lastThumb = info.thumb || '';
      if (info.title === undefined) lastThumb = '';
      info.thumb = lastThumb;
      delete info.key;
      sendWin('media', info);
    } catch {}
    schedule();
  };
  const start = () => {
    buf = '';
    mediaChild = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Loop'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ATULS_MEDIA_BLOCK: mediaBlockList().join('|') } });
    mediaChild.stdout.setEncoding('utf8');
    mediaChild.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(l); } });
    mediaChild.stdin.on('error', () => {});
    mediaChild.on('close', () => { mediaChild = null; waiting = false; });
    mediaChild.on('error', (e) => { console.error('[island] media helper failed:', e.message); mediaChild = null; });
  };
  const tick = () => {
    if (screenLocked) return schedule(); // nobody is looking
    if (!mediaChild) start();
    if (waiting) { schedule(); return; }
    try { waiting = true; mediaChild.stdin.write('\n'); } catch { waiting = false; schedule(); }
    // no answer in 10 s: the helper is stuck; replace it
    setTimeout(() => { if (waiting) { waiting = false; mediaStop(); schedule(); } }, 10000).unref();
  };
  mediaSend = (cmd) => { // play / next / prev for the player, then the helper answers with the new state
    if (!mediaChild) start();
    try { mediaChild.stdin.write(cmd + '\n'); return true; } catch { return false; }
  };
  powerMonitor.on('lock-screen', () => { screenLocked = true; });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; });
  tick();
}


let permOk = true, asked = false, seenMove = false, lastHookAt = Date.now();

// Windows: the name uiohook uses for a key of the low-level keyboard hook (virtual key code + extended flag), or ''
const WIN_KEYS = (() => {
  const t = {};
  for (let i = 0; i < 26; i++) t[0x41 + i] = String.fromCharCode(65 + i);
  for (let i = 0; i < 10; i++) { t[0x30 + i] = String(i); t[0x60 + i] = 'Numpad' + i; }
  for (let i = 1; i <= 24; i++) t[0x6F + i] = 'F' + i;
  Object.assign(t, { 0x08: 'Backspace', 0x09: 'Tab', 0x0D: 'Enter', 0x14: 'CapsLock', 0x1B: 'Escape', 0x20: 'Space', 0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
    0x25: 'ArrowLeft', 0x26: 'ArrowUp', 0x27: 'ArrowRight', 0x28: 'ArrowDown', 0x2C: 'PrintScreen', 0x2D: 'Insert', 0x2E: 'Delete', 0x5B: 'Meta', 0x5C: 'MetaRight',
    0x6A: 'NumpadMultiply', 0x6B: 'NumpadAdd', 0x6D: 'NumpadSubtract', 0x6E: 'NumpadDecimal', 0x6F: 'NumpadDivide', 0x90: 'NumLock', 0x91: 'ScrollLock',
    0xA0: 'Shift', 0xA1: 'ShiftRight', 0xA2: 'Ctrl', 0xA3: 'CtrlRight', 0xA4: 'Alt', 0xA5: 'AltRight', 0x10: 'Shift', 0x11: 'Ctrl', 0x12: 'Alt',
    0xBA: 'Semicolon', 0xBB: 'Equal', 0xBC: 'Comma', 0xBD: 'Minus', 0xBE: 'Period', 0xBF: 'Slash', 0xC0: 'Backquote', 0xDB: 'BracketLeft', 0xDC: 'Backslash', 0xDD: 'BracketRight', 0xDE: 'Quote' });
  return t;
})();
function winKeyName(k) {
  if (k.vkCode === 0x0D && (k.flags & 1)) return 'NumpadEnter';
  return WIN_KEYS[k.vkCode] || '';
}

// Put the input hooks back when the system dropped them (after sleep or lock, or when one timed out).
// NEVER stop/start the global input hook (uiohook) while input may be flowing: stop() waits for the hook thread, which can be
// waiting for this thread, and the whole process deadlocks (it then cannot even be killed: it stays as a one-thread zombie that
// keeps its hooks registered). Windows: only our own hooks are put back. macOS: restart only while nothing is being touched.
let hookReinstalledAt = 0;
function reinstallInput(why) {
  console.log('[island] reinstalling input hooks:', why);
  if (diag) { diag.count('hook.reinstall'); diag.event('hook.reinstall', { why }); }
  hookReinstalledAt = Date.now();
  if (process.platform === 'win32') native.reinstallHooks();
  else input.restartHook();
  lastHookAt = Date.now();
}
function startHookWatchdog() {
  // system input keeps arriving but none of our hooks hear it: they were dropped
  if (process.platform === 'win32') setInterval(() => {
    const idle = native.winIdleMs();
    if (idle !== null && idle < 600 && Date.now() - lastHookAt > 3000 && lastHookAt > hookReinstalledAt) reinstallInput('hooks went silent');
  }, 2000);
  powerMonitor.on('resume', () => setTimeout(() => reinstallInput('resume'), 1500));
  powerMonitor.on('unlock-screen', () => setTimeout(() => reinstallInput('unlock'), 800));
}

// A burst of display notifications (plugging, waking, changing resolution) settles into one update:
// wait 300 ms, then read the layout every 100 ms until two reads agree (at most 8).
let displayTimer = null;
function settleDisplays(tries = 0, previous = null) {
  refreshPhysicalSizes();
  const now = JSON.stringify(displaysList());
  if (now === previous || tries >= 8) { link.setDisplays(JSON.parse(now)); return; }
  displayTimer = setTimeout(() => settleDisplays(tries + 1, now), 100);
}
const onDisplaysChanged = () => { clearTimeout(displayTimer); displayTimer = setTimeout(() => settleDisplays(), 300); };
// Self test: a small window with a text field that takes the focus, so keys sent by the other computer end up somewhere we can read.
function keySink() {
  const { BrowserWindow } = require('electron');
  const w = new BrowserWindow({ width: 340, height: 120, show: true, alwaysOnTop: true, title: 'A-tuls key test', webPreferences: { contextIsolation: true } });
  w.loadURL('data:text/html,<body style="font:14px sans-serif">Key test<br><input id=i autofocus style="width:300px;font-size:18px"></body>');
  w.once('ready-to-show', () => { app.focus && app.focus({ steal: true }); w.focus(); w.webContents.focus(); });
  setTimeout(async () => {
    try { const v = await w.webContents.executeJavaScript('document.getElementById("i").value'); lifecycle.line('keysink: the text field received ' + JSON.stringify(v) + ', window focused: ' + w.isFocused()); } catch (e) { lifecycle.line('keysink failed: ' + e.message); }
    try { w.destroy(); } catch {}
  }, 14000);
}
// First pairing: a small window with six numbers; the person says whether they match the numbers on the other computer.
let sasWin = null;
function setupSas() {
  lifecycle.line('pairing tokens encrypted on disk: ' + link.store.sealed());
  const close = () => { try { if (sasWin && !sasWin.isDestroyed()) { sasWin.removeAllListeners('closed'); sasWin.destroy(); } } catch {} sasWin = null; };
  link.on('sas', (d) => {
    close();
    lifecycle.line('pairing: waiting for the person to compare the numbers (' + d.role + ')');
    sasWin = new BrowserWindow({ width: 380, height: 290, show: false, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, center: true, title: 'A-tuls - confirm pairing', backgroundColor: '#141416', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'sas-preload.js'), contextIsolation: true } });
    sasWin.setMenu(null);
    sasWin.loadFile(path.join(__dirname, 'sas.html'));
    sasWin.webContents.once('did-finish-load', () => { try { sasWin.webContents.send('sas:show', d); sasWin.show(); app.focus && app.focus({ steal: true }); sasWin.focus(); } catch {} });
    sasWin.on('closed', () => { sasWin = null; link.sasAnswer(false); lifecycle.line('pairing: window closed, treated as "different"'); });
  });
  link.on('sas-end', close);
  ipcMain.on('sas:answer', (_e, yes) => { lifecycle.line('pairing: the person said ' + (yes ? 'the numbers match' : 'the numbers are different')); link.sasAnswer(yes); });
}
// macOS: until Accessibility access is allowed nothing works, so a window explains it and opens the right pane of System Settings.
let onboardWin = null;
function showOnboard() {
  if (onboardWin && !onboardWin.isDestroyed()) return;
  onboardWin = new BrowserWindow({ width: 480, height: 400, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, center: true, title: 'A-tuls - allow access', backgroundColor: '#141416', webPreferences: { preload: path.join(__dirname, 'onboard-preload.js'), contextIsolation: true } });
  onboardWin.setMenu(null);
  onboardWin.loadFile(path.join(__dirname, 'onboard.html'));
  onboardWin.on('closed', () => { onboardWin = null; });
  lifecycle.line('onboarding: asked the person to allow Accessibility and Input Monitoring');
}
function closeOnboard() { try { if (onboardWin && !onboardWin.isDestroyed()) { onboardWin.destroy(); lifecycle.line('onboarding: access allowed, window closed'); } } catch {} onboardWin = null; }
// macOS: while a permission is missing, the window shows which one is still open and tells the person when everything is allowed (a short "all set"
// message in the window, a notice on the pill, then the window closes). Nothing is shown when both are already allowed.
let accessWatching = false, accessDismissed = false;
function accessState() {
  const ax = systemPreferences.isTrustedAccessibilityClient(false);
  return { ax, im: native.macInputMonitoring() !== false };
}
function watchAccess() {
  if (process.platform !== 'darwin' || accessWatching) return;
  accessWatching = true;
  let wasMissing = !!(onboardWin && !onboardWin.isDestroyed());
  setInterval(() => {
    const st = accessState();
    const missing = !(st.ax && st.im);
    if (missing && !wasMissing) { wasMissing = true; accessDismissed = false; lifecycle.line(`access missing: Accessibility ${st.ax ? 'ok' : 'needed'}, Input Monitoring ${st.im ? 'ok' : 'needed'}`); }
    if (missing && !accessDismissed && (!onboardWin || onboardWin.isDestroyed())) { showOnboard(); onboardWin.on('closed', () => { if (accessState().ax === false || native.macInputMonitoring() === false) accessDismissed = true; }); }
    if (onboardWin && !onboardWin.isDestroyed()) onboardWin.webContents.send('onboard:status', st);
    if (!missing && wasMissing) {
      wasMissing = false;
      lifecycle.line('access: everything allowed');
      toast('Access allowed', 'A-tuls is ready to use', 'ok');
      setTimeout(closeOnboard, 2500);
    }
  }, 1500).unref();
}
ipcMain.on('onboard:restart', () => { lifecycle.line('onboarding: restart asked'); app.relaunch(); app.quit(); });
ipcMain.on('onboard:open', (_e, pane) => { if (/^Privacy_(Accessibility|ListenEvent)$/.test(pane)) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?' + pane); });
let relockTries = [];
let hookDownLog = 0, hookUpLog = 0, ovBtnLog = 0, hookLogUntil = 0;
function startInput() {
  console.log('[island] checking input access');
  // macOS refuses global mouse hooks until Accessibility access is granted
  if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(!asked)) {
    if (!asked) console.log('[island] waiting for Accessibility permission (System Settings > Privacy & Security > Accessibility)');
    asked = true;
    showOnboard();
    if (permOk) { permOk = false; sendWin('perm', false); }
    return setTimeout(startInput, 2000);
  }
  try {
    // swallow keystrokes locally while controlling the other computer (must be installed before uiohook)
    const swallowedKeys = new Set(); // swallow a release only if its press was swallowed too, or the key stays stuck down
    // A swallowed key must not depend on uiohook to be forwarded: uiohook only hears it while it sits above this hook, and after the
    // hooks are put back (unlock, sleep, a silent drop) this hook is on top, so clicks and typing never reached the other computer.
    // So this hook forwards what it swallows itself; when uiohook reports the same key too, the second report is dropped.
    const fwdKeys = new Set(), keySeen = new Map();
    const dupKey = (id, src) => { // true when the other source already reported this very key event a moment ago
      const now = Date.now(), p = keySeen.get(id);
      if (p && p.src !== src && now - p.t < 250) { keySeen.delete(id); return true; }
      keySeen.set(id, { src, t: now });
      return false;
    };
    const fwdKey = (k, down) => {
      const name = winKeyName(k);
      if (!name || dupKey(name + (down ? 'd' : 'u'), 'hook')) return;
      link.lastHookKey = Date.now(); link.onLocalKey(down, name);
    };
    link.dupKey = dupKey;
    const blockKeys = (k) => {
      lastHookAt = Date.now();
      if (k.flags & 0x10) return false; // injected by us
      if (k.flags & 0x80) { const was = swallowedKeys.delete(k.vkCode); if (fwdKeys.delete(k.vkCode)) fwdKey(k, false); return was; }
      if (link.lockedOut()) { // master mode: this keyboard is switched off, except Ctrl / Alt / Shift on their own and any key while Ctrl+Alt are held (the take-over shortcut)
        const vk = k.vkCode;
        if ((vk >= 0xA0 && vk <= 0xA5) || (vk >= 0x10 && vk <= 0x12) || native.winCtrlAlt()) return false;
        swallowedKeys.add(vk); return true;
      }
      if (link.state === 'controlling' || link.recorder) { swallowedKeys.add(k.vkCode); fwdKeys.add(k.vkCode); fwdKey(k, true); return true; } // recording a shortcut: the keys belong to the settings window
      return false;
    };
    if (native.installKeyBlocker(blockKeys)) console.log('[island] key blocker installed');
    if (native.installMouseHook((msg, info) => { lastHookAt = Date.now(); return link.onWinMouse(msg, info); })) { link.external = true; console.log('[island] mouse hook installed'); }
    console.log('[island] starting input hook');
    input.start({
      move: (x, y) => { lastHookAt = Date.now(); if (!seenMove) { seenMove = true; console.log('[island] receiving mouse events'); } link.onLocalMove(x, y); },
      down: (b, n) => { if (link.state === 'controlling' || Date.now() < hookLogUntil || (hookDownLog = (hookDownLog || 0) + 1) <= 12) lifecycle.line('mouse button ' + b + ' down seen by the hook, link state ' + link.state); closeIfPinnedOutside(); pillClickCheck(b); link.onLocalButton(true, b, n); },
      up: (b) => { if (link.state === 'controlling' || Date.now() < hookLogUntil || (hookUpLog = (hookUpLog || 0) + 1) <= 12) lifecycle.line('mouse button ' + b + ' up seen by the hook, link state ' + link.state); link.onLocalButton(false, b); },
      wheel: (d, r) => link.onLocalWheel(d, r),
      key: (name, down) => { if (process.platform === 'win32' && link.dupKey && link.dupKey(name + (down ? 'd' : 'u'), 'uio')) return; link.lastHookKey = Date.now(); if (link.state === 'controlled' && (link.hookKeyLog = (link.hookKeyLog || 0) + 1) <= 8) lifecycle.line('hook saw key ' + name + (down ? ' down' : ' up') + ' while controlled'); link.onLocalKey(down, name); },
    });
    permOk = true;
    watchAccess();
    console.log('[island] input hook started');
    if (process.platform === 'darwin' && native.installScrollTap((x, y) => link.onMacScroll(x, y))) console.log('[island] scroll tap installed');
    sendWin('perm', true);
  } catch (e) {
    console.error('input hook failed:', e.message);
    permOk = false;
    sendWin('perm', false);
    setTimeout(startInput, 3000);
  }
}

// ---- screenshots are saved into one folder ------------------------------------
// Screenshots taken with A-tuls (the screenshot button / shortcut, on either computer) and the system's own shortcut are copied to the
// clipboard by the system; the clipboard watcher below sees them and writes each one as a PNG file into the chosen folder.
const shotDir = () => store.get('shotDir', '');
const shotOn = () => !!store.get('shotSave', false) && !!shotDir();
const ownShots = new Set(); // files A-tuls wrote itself (the Mac watcher must not treat them as new screenshots)
let macShotDir = '', macShotSkipUntil = 0;
// returns the name of the saved file ('' when nothing was saved); the notice itself is made by the clipboard watcher, once per screenshot
function saveShot(png, why) {
  if (!shotOn()) return '';
  // macOS already put this picture into the folder (the folder of the system screenshots is the chosen one): no second copy
  if (macShotSkipUntil > Date.now() && path.resolve(shotDir()) === path.resolve(macShotDir)) { macShotSkipUntil = 0; lifecycle.line('screenshot already in the folder (saved by macOS)'); return ''; }
  try {
    fs.mkdirSync(shotDir(), { recursive: true });
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const base = 'Screenshot ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '.' + p(d.getMinutes()) + '.' + p(d.getSeconds());
    const jpg = store.get('shotFormat', 'png') === 'jpg';
    const ext = jpg ? '.jpg' : '.png';
    let file = path.join(shotDir(), base + ext);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(shotDir(), base + ' (' + i + ')' + ext);
    fs.writeFileSync(file, jpg ? nativeImage.createFromBuffer(png).toJPEG(92) : png);
    ownShots.add(path.basename(file));
    lifecycle.line('screenshot saved (' + why + '): ' + file);
    checkShotLimit();
    return path.basename(file);
  } catch (e) { lifecycle.line('screenshot could not be saved: ' + e.message); return ''; }
}

// Self test of the screenshot folder: a tiny picture is put on the clipboard right after a screenshot is marked, and must appear as a file.
// Sharing is switched off meanwhile and the old settings and clipboard text are put back, so nothing leaks to the other computer.
async function shotSelfTest() {
  const L = (t) => lifecycle.line('shot selftest: ' + t);
  const keep = { dir: store.get('shotDir', ''), on: store.get('shotSave', false), fmt: store.get('shotFormat', 'png'), lim: store.get('shotLimitMb', 500) };
  const dir = path.join(os.tmpdir(), 'island-shotself-' + Date.now());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  try {
    store.set('shotDir', dir); store.set('shotSave', true);
    // 1. JPG
    store.set('shotFormat', 'jpg'); saveShot(png, 'selftest');
    const j = fs.readdirSync(dir).filter((n) => /\.jpg$/.test(n));
    const head = j.length ? fs.readFileSync(path.join(dir, j[0])).subarray(0, 3).toString('hex') : '';
    L('jpg: ' + (j.length === 1 && head === 'ffd8ff' ? 'OK (' + j[0] + ', JPEG header)' : 'FAILED ' + JSON.stringify({ j, head })));
    store.set('shotFormat', 'png'); saveShot(png, 'selftest');
    L('png: ' + (fs.readdirSync(dir).some((n) => /\.png$/.test(n)) ? 'OK' : 'FAILED'));
    // 2. the limit: 8 files of 300 KB, limit 1 MB
    for (let i = 0; i < 8; i++) { const f = path.join(dir, 'old-' + i + '.png'); fs.writeFileSync(f, Buffer.alloc(300 * 1024, i)); const t = Date.now() / 1000 - (100 - i) * 60; fs.utimesSync(f, t, t); }
    const total = () => shotFolderFiles().reduce((n, x) => n + x.size, 0);
    const before = total();
    store.set('shotLimitMb', 1);
    limitSnoozeUntil = 0;
    let asked = null;
    await checkShotLimit(async (o) => { asked = o; return { response: 1 }; }); // Keep everything
    L('keep: asked=' + !!asked + ' (' + (asked ? asked.message : '') + '), files unchanged=' + (total() === before) + ', next limit ' + store.get('shotLimitMb') + ' MB');
    store.set('shotLimitMb', 1); limitSnoozeUntil = 0;
    await checkShotLimit(async () => ({ response: 0 })); // Delete the oldest
    const left = shotFolderFiles();
    const oldestGone = !fs.existsSync(path.join(dir, 'old-0.png')) && fs.existsSync(path.join(dir, 'old-7.png'));
    L('delete: ' + left.length + ' files left, ' + (total() / 1024).toFixed(0) + ' KB (target under ' + (1024 * 0.6).toFixed(0) + ' KB), oldest removed and newest kept=' + oldestGone);
    store.set('shotLimitMb', 500); limitSnoozeUntil = 0;
    let askedBelow = false;
    await checkShotLimit(async () => { askedBelow = true; return { response: 1 }; });
    L('below the limit: no question=' + !askedBelow);
  } catch (e) { L('FAILED ' + e.message); }
  finally {
    store.set('shotDir', keep.dir); store.set('shotSave', keep.on); store.set('shotFormat', keep.fmt); store.set('shotLimitMb', keep.lim); limitSnoozeUntil = 0;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    L('settings put back');
  }
}

async function shotTest() {
  const keep = { dir: store.get('shotDir', ''), on: store.get('shotSave', false), clip: store.get('clipboard', true) };
  const prevText = await clipboard.readText().catch(() => '');
  const dir = path.join(os.tmpdir(), 'island-shottest-' + Date.now());
  try {
    store.set('shotDir', dir); store.set('shotSave', true); store.set('clipboard', false);
    link.markShot();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    await new Promise((r) => setTimeout(r, 2500));
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    lifecycle.line('shottest: ' + (files.length ? 'saved ' + files.join(', ') + ' (' + fs.statSync(path.join(dir, files[0])).size + ' bytes)' : 'NOTHING was saved'));
  } catch (e) { lifecycle.line('shottest failed: ' + e.message); }
  finally {
    store.set('shotDir', keep.dir); store.set('shotSave', keep.on); store.set('clipboard', keep.clip);
    try { await clipboard.writeText(prevText || ''); lastClip = ''; } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// macOS: the system's own screenshot shortcuts (Cmd+Shift+3/4/5) write a FILE and leave the clipboard alone, so such a screenshot could not be pasted
// and never reached the other computer. The folder macOS saves into is watched: each new screenshot file is also put on the clipboard (which
// shares it with the other computer and, if wanted, saves it in the A-tuls folder).
function watchMacScreenshots() {
  if (!MAC) return;
  let dir = path.join(os.homedir(), 'Desktop');
  try { const d = require('child_process').execFileSync('defaults', ['read', 'com.apple.screencapture', 'location'], { timeout: 3000 }).toString().trim(); if (d) dir = d.replace(/^~/, os.homedir()); } catch {}
  if (!fs.existsSync(dir)) { lifecycle.line('screenshot watcher: folder not found: ' + dir); return; }
  macShotDir = dir;
  const seen = new Set(fs.readdirSync(dir));
  const pending = new Map();
  const handle = async (name) => {
    pending.delete(name);
    const file = path.join(dir, name);
    try {
      let size = -1;
      for (let i = 0; i < 8; i++) { const st = fs.statSync(file); if (st.size > 0 && st.size === size) break; size = st.size; await new Promise((r) => setTimeout(r, 250)); } // wait until the file is complete
      if (size <= 0 || size > 30 * 1024 * 1024) return;
      const png = fs.readFileSync(file);
      link.markShot();
      macShotSkipUntil = Date.now() + 6000;
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      lifecycle.line('screenshot file put on the clipboard: ' + name);
    } catch (e) { lifecycle.line('screenshot watcher failed: ' + e.message); }
  };
  try {
    fs.watch(dir, (_ev, name) => {
      if (!name || name.startsWith('.') || !/^(Screenshot|Screen Shot).*\.png$/i.test(name) || seen.has(name) || ownShots.has(name) || pending.has(name)) return;
      seen.add(name);
      pending.set(name, setTimeout(() => handle(name), 400));
    });
    lifecycle.line('screenshot watcher: ' + dir);
  } catch (e) { lifecycle.line('screenshot watcher could not start: ' + e.message); }
}

// ---- the screenshot folder has a size limit: at the limit the person chooses what happens --------------------------------------------
const IMAGE_FILE = /\.(png|jpe?g)$/i;
function shotFolderFiles() {
  const dir = shotDir();
  try { return fs.readdirSync(dir).filter((n) => IMAGE_FILE.test(n) && !n.startsWith('.')).map((n) => { const f = path.join(dir, n); const st = fs.statSync(f); return { f, size: st.size, t: st.mtimeMs }; }); } catch { return []; }
}
let limitAsking = false, limitSnoozeUntil = 0;
async function checkShotLimit(ask) {
  if (limitAsking || Date.now() < limitSnoozeUntil || !shotOn()) return;
  const MB = 1024 * 1024, limit = store.get('shotLimitMb', 500) * MB;
  const files = shotFolderFiles();
  const total = files.reduce((n, x) => n + x.size, 0);
  if (total < limit) return;
  limitAsking = true;
  try {
    const mb = (n) => Math.round(n / MB);
    const r = await (ask || ((o) => dialog.showMessageBox(o)))({
      type: 'warning', title: 'A-tuls', message: 'The screenshot folder has reached ' + mb(total) + ' MB',
      detail: 'Limit: ' + mb(limit) + ' MB (' + files.length + ' pictures)\n' + shotDir() + '\n\nDelete the oldest pictures (they go to the Trash, down to 60% of the limit), or keep everything and be asked again after another ' + mb(limit) + ' MB.',
      buttons: ['Delete the oldest', 'Keep everything', 'Open the folder'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (r.response === 0) {
      let left = total, n = 0;
      for (const x of files.sort((a, b) => a.t - b.t)) { if (left <= limit * 0.6) break; try { await shell.trashItem(x.f); left -= x.size; n++; } catch (e) { lifecycle.line('screenshot cleanup: ' + e.message); } }
      lifecycle.line('screenshot folder: ' + n + ' old pictures moved to the Trash, ' + mb(left) + ' MB left');
      toast('Screenshots cleaned', n + ' old pictures in the Trash', 'ok');
    } else if (r.response === 1) {
      store.set('shotLimitMb', Math.round(limit / MB) + Math.round(limit / MB)); // asked again after another stretch of the same size
      lifecycle.line('screenshot folder: kept, next question at ' + store.get('shotLimitMb') + ' MB');
    } else { shell.openPath(shotDir()); limitSnoozeUntil = Date.now() + 10 * 60 * 1000; }
  } catch (e) { lifecycle.line('screenshot limit dialog failed: ' + e.message); }
  limitAsking = false;
}

// macOS: where the system's own screenshots go. By default they become a file only, and show a floating thumbnail first, so the file appears up to
// five seconds after the screenshot and the clipboard is never used. While A-tuls runs (and saves screenshots), the destination is the
// clipboard: the picture can be pasted at once and A-tuls writes the file itself. The old setting is put back when the app quits.
const macDefaults = (...a) => require('child_process').execFileSync('defaults', a, { timeout: 3000 }).toString().trim();
function macTargetSync() {
  if (!MAC) return;
  const want = store.get('macClip', true) && shotOn();
  try {
    if (want) {
      if (store.get('macTargetOrig', null) === null) { let orig; try { orig = macDefaults('read', 'com.apple.screencapture', 'target'); } catch { orig = '__unset__'; } store.set('macTargetOrig', orig); }
      if ((() => { try { return macDefaults('read', 'com.apple.screencapture', 'target'); } catch { return ''; } })() !== 'clipboard') { macDefaults('write', 'com.apple.screencapture', 'target', 'clipboard'); lifecycle.line('mac screenshots now go to the clipboard first (A-tuls saves the file)'); }
    } else macTargetRestore();
  } catch (e) { lifecycle.line('mac screenshot target: ' + e.message); }
}
function macTargetRestore() {
  if (!MAC) return;
  const orig = store.get('macTargetOrig', null);
  if (orig === null) return;
  try {
    if (orig === '__unset__') { try { macDefaults('delete', 'com.apple.screencapture', 'target'); } catch {} } else macDefaults('write', 'com.apple.screencapture', 'target', orig);
    lifecycle.line('mac screenshot target put back to ' + (orig === '__unset__' ? 'the default' : orig));
  } catch (e) { lifecycle.line('mac screenshot target restore failed: ' + e.message); }
  store.set('macTargetOrig', null);
}

// ---- clipboard sharing (text + images) -----------------------------------
let lastClip = '';
const clipOn = () => store.get('clipboard', true);
// Electron 44's clipboard API is promise based and has no image helpers: items carry MIME types and Blobs
// On Windows, reading a picture from the clipboard can wait for the program that put it there (a screenshot tool, Photoshop) to produce it.
// If that program is slow or stuck, the reader waits too, and when the reader is this app's main thread, the mouse and keyboard hooks wait with
// it (that is how the whole system can lag or freeze). So: (1) the clipboard is only touched when its change counter moved, not every poll, and
// (2) pictures are read by a small helper process that is given up on after 5 seconds, so a stuck owner can only block the helper.
let clipSeq = -1;
function clipboardMoved() {
  if (process.platform !== 'win32') return true;
  const s = native.winClipboardSeq();
  if (s === null || s === undefined) return true;
  if (s === clipSeq) return false;
  clipSeq = s;
  return true;
}
const IMAGE_HELPER = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $i = [System.Windows.Forms.Clipboard]::GetImage(); if ($i) { $m = New-Object System.IO.MemoryStream; $i.Save($m, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) }";
function readImageViaHelper() {
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    let ps = null;
    try { ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', IMAGE_HELPER], { windowsHide: true }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { ps.kill(); } catch {} lifecycle.line('clipboard picture: the program that owns it did not answer in 5 s, skipped'); finish(null); }, 5000);
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => finish(null));
    ps.on('close', () => finish(out.trim() ? Buffer.from(out.trim(), 'base64') : null));
  });
}
// a change with nothing readable yet (the owner is still filling the clipboard) is looked at again a few times
let clipEmpty = 0;
async function readClip() {
  if (!clipboardMoved()) return null;
  const c = await readClipNow();
  if (c) clipEmpty = 0; else if (++clipEmpty <= 3) clipSeq = -1;
  return c;
}
async function readClipNow() {
  if (await clipboard.has('image/png')) {
    if (process.platform === 'win32') {
      const png = await readImageViaHelper();
      if (png && png.length) return { hash: 'i' + crypto.createHash('md5').update(png).digest('hex'), kind: 'image', data: png.toString('base64') };
    } else {
      const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
      if (item) {
        const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
        return { hash: 'i' + crypto.createHash('md5').update(png).digest('hex'), kind: 'image', data: png.toString('base64') };
      }
    }
  }
  const text = await clipboard.readText();
  if (text) return { hash: 't' + crypto.createHash('md5').update(text).digest('hex'), kind: 'text', text };
  return null;
}
let clipBusy = false, remoteClipUntil = 0;
function startClipboardSync() {
  setInterval(async () => {
    // the watcher also runs without a link (or with sharing off) while screenshots are being saved to a folder
    if (clipBusy || (!(clipOn() && link.sock) && !shotOn() && !(link.shotUntil > Date.now()))) return;
    clipBusy = true;
    try {
      const c = await readClip();
      if (!c || c.hash === lastClip) return;
      lastClip = c.hash;
      if (c.kind === 'image' && c.data.length > 30 * 1024 * 1024) return;
      // A picture that arrived from the other computer is never a screenshot taken here (writing it into this clipboard is not a new one).
      const shot = c.kind === 'image' && link.shotUntil > Date.now() && Date.now() >= remoteClipUntil; // a screenshot just taken on this computer
      if (shot) {
        link.shotUntil = 0; // one screenshot, one notice: a clipboard that is re-encoded a moment later does not count again
        const name = shotOn() ? saveShot(Buffer.from(c.data, 'base64'), 'taken here') : '';
        // one notice, when the picture is in the clipboard, on the computer the person is at (not on both)
        lifecycle.line('screenshot in the clipboard' + (name ? ', saved as ' + name : '') + (link.here() ? ', notice shown' : ', no notice: the pointer is not here'));
        if (link.here()) toast('Screenshot copied', name ? 'Saved as ' + name : 'It is in your clipboard', 'ok'); // on the computer it was taken on (where the pointer is), not on the other one
      }
      if (!clipOn() || !link.sock) return;
      console.log('[island] clipboard ->', c.kind);
      link.send({ t: 'clip', kind: c.kind, text: c.text, data: c.kind === 'image' ? c.data : undefined, shot });
    } catch (e) {
      console.error('[island] clipboard read failed:', e.message);
    } finally { clipBusy = false; }
  }, 800);
}
async function applyRemoteClip(m) {
  console.log('[island] clipboard <-', m.kind, clipOn() ? '' : '(sharing off)');
  if (!clipOn()) return;
  clipBusy = true;
  try {
    if (m.kind === 'text' && typeof m.text === 'string') await clipboard.writeText(m.text);
    else if (m.kind === 'image' && m.data) {
      remoteClipUntil = Date.now() + 4000; // what lands in this clipboard now came from the other computer: nothing sent back
      link.shotUntil = 0;
      if (m.shot && store.get('shotOther', true)) saveShot(Buffer.from(m.data, 'base64'), 'taken on the other computer');
      const blob = new Blob([Buffer.from(m.data, 'base64')], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } else return;
    // remember what we just wrote so the poller doesn't bounce it back
    const c = await readClip();
    if (c) lastClip = c.hash;
  } catch (e) {
    console.error('[island] clipboard write failed:', e.message);
  } finally { clipBusy = false; }
}


// ---- Look to switch (webcam head pose, processed locally in a hidden page) ----
// The camera is open only while the feature is on AND a computer is linked; turning it off closes the page.
let gazeActivePeer = null, gazeWin = null, gazeCam = false, gazeError = '', gazeMsg = '', calib = null, calibBusy = false;
const zones = new ZoneTracker();
const gazeOn = () => store.get('gazeOn', false);
const gazeCals = () => store.get('gazeCal', {});
function gazeStatus() {
  const peerId = link && link.peer && link.peer.id;
  return { enabled: gazeOn(), camera: gazeCam, linked: !!peerId, calibrated: !!(peerId && gazeCals()[peerId]), calibrating: calibBusy, error: gazeError, msg: gazeMsg, preview: gazePreview };
}
let gazeQuit = false, gazePreview = false;
function setPreview(v) {
  gazePreview = !!v && !!gazeWin;
  if (!gazeWin || gazeWin.isDestroyed()) return pushGaze();
  gazeWin.webContents.send('gaze:cmd', gazePreview ? 'preview-on' : 'preview-off');
  if (gazePreview) gazeWin.showInactive(); else gazeWin.hide();
  pushGaze();
}
function pushGaze() { sendWin('gaze', gazeStatus()); }
// Look to switch needs somebody in front of the screen: the camera is closed after 10 minutes without any keyboard or mouse use, or while the
// screen is locked, and opens again at the first touch (the first seconds of tracking are not needed then: the pointer is in use anyway).
let gazeSuspended = false, gazeWakeUntil = 0;
// Only ONE camera runs: the one on the computer where a hand last touched the mouse or keyboard (the person is sitting there). Both computers
// tell each other how long ago that was. The camera STAYS where it is and moves only when the other computer was used clearly more recently
// (8 seconds or more): moving it means a camera start and a model warm-up of a couple of seconds, during which head tracking is blind. At the
// first contact the computer with the higher id gets it, so both always agree.
const GAZE_STICKY_S = 8;
let peerIdle = null, peerCal = false, peerCam = false, peerCalibrating = false, gazeMine = true, gazeDecided = false, linkSeenAt = 0;
const myCal = () => !!(link && link.peer && gazeCals()[link.peer.id]);
const handIdle = () => (link && link.physicalAt ? (Date.now() - link.physicalAt) / 1000 : 3600);
function gazeBalance() {
  let mine = gazeMine;
  if (!link || !link.peer) { mine = true; gazeDecided = false; linkSeenAt = 0; } // alone: run
  else if (peerIdle === null) { // linked, but the other side has not said anything yet: wait a moment instead of both opening the camera
    if (!linkSeenAt) linkSeenAt = Date.now();
    mine = Date.now() - linkSeenAt > 5000;
  }
  else if (calibBusy) mine = true; // calibrating here
  else if (peerCalibrating) mine = false; // calibrating there
  // one calibration is enough: it can track the head in both directions, so the camera belongs to the computer that has one
  else if (myCal() !== peerCal) mine = myCal();
  else if (!gazeDecided) { mine = link.id > link.peer.id; gazeDecided = true; }
  else {
    const my = handIdle();
    if (gazeMine && peerIdle < my - GAZE_STICKY_S) mine = false;
    else if (!gazeMine && my < peerIdle - GAZE_STICKY_S) mine = true;
  }
  // never two cameras: when the other computer says its camera is on as well, the one where a hand was used last keeps it (a tie goes by id)
  if (mine && peerCam && link && link.peer && !calibBusy && !peerCalibrating && peerIdle !== null) {
    const my = handIdle();
    mine = my < peerIdle || (my === peerIdle && link.id > link.peer.id);
  }
  if (mine === gazeMine) return;
  gazeMine = mine;
  lifecycle.line('look to switch: ' + (mine ? 'the camera of this computer is the one in use' : 'the other computer is in use, this camera is closed'));
  applyGaze();
  gazeShareIdle(true); // tell the other computer at once, so it does not wait for the next round
}
function gazeShareIdle(noBalance) {
  if (link && link.sock) link.send({ t: 'gazeidle', idle: Math.round(handIdle()), cal: myCal(), cam: !!(gazeMine && gazeOn() && !gazeSuspended), calibrating: !!calibBusy });
  if (!noBalance) gazeBalance();
}
// The camera is also closed after 10 minutes without any keyboard or mouse use, or while the screen is locked, and it opens again at the first
// touch. It is never closed for idleness while calibrating, just after the person asked for it, or during control.
function gazeIdleWatch() {
  const check = () => {
    const idle = powerMonitor.getSystemIdleTime();
    const away = screenLocked || (idle >= 600 && Date.now() > gazeWakeUntil && !calibBusy && !calib && link && link.state === 'idle');
    if (away === gazeSuspended) return;
    gazeSuspended = away;
    lifecycle.line('look to switch: camera ' + (away ? 'closed (nobody at the computer)' : 'opened again'));
    applyGaze();
  };
  setInterval(check, 5000);
  setInterval(gazeShareIdle, 3000);
  link.on('gazeidle', (n) => { peerIdle = n && Number.isFinite(n.idle) ? n.idle : null; peerCal = !!(n && n.cal); peerCam = !!(n && n.cam); peerCalibrating = !!(n && n.calibrating); gazeBalance(); });
  link.on('status', (st) => { if (!st.connected) { peerIdle = null; peerCam = false; peerCalibrating = false; linkSeenAt = 0; } gazeBalance(); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; check(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; check(); });
}
async function applyGaze() {
  const want = gazeOn() && link && link.sock && link.peer && !gazeSuspended && (gazeMine || calibBusy);
  if (want && !gazeWin) {
    gazeError = '';
    // macOS only shows the camera permission prompt when the app asks for it from the main process
    if (process.platform === 'darwin' && (await systemPreferences.askForMediaAccess('camera')) === false) {
      gazeError = 'camera access denied (System Settings > Privacy & Security > Camera)';
      store.set('gazeOn', false);
      return pushGaze();
    }
    if (gazeWin || !gazeOn()) return;
    gazeWin = new BrowserWindow({
      show: false, width: 320, height: 300, useContentSize: true, resizable: false, autoHideMenuBar: true, alwaysOnTop: true, title: 'Look to switch - camera preview',
      webPreferences: { preload: path.join(__dirname, 'gaze-preload.js'), contextIsolation: true, backgroundThrottling: false, partition: 'island-gaze' },
    });
    const ses = gazeWin.webContents.session;
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'media');
    gazeWin.webContents.on('console-message', (_e, _l, msg) => { console.log('[gaze]', msg); if (/gaze|delegate|failed|error/i.test(msg) && !/Security Warning/.test(msg)) lifecycle.line('gaze page: ' + String(msg).slice(0, 220)); });
    gazeWin.on('close', (e) => { if (!gazeQuit && gazeWin && !gazeWin.isDestroyed()) { e.preventDefault(); setPreview(false); } }); // closing the preview only hides it
    gazeWin.on('closed', () => { gazeWin = null; gazeCam = false; pushGaze(); });
    gazeWin.loadFile(path.join(__dirname, 'gaze.html')).then(() => gazeWin && !gazeWin.isDestroyed() && gazeWin.webContents.send('gaze:cmd', 'start')).catch(() => {}); // closed again while loading: nothing to do
  } else if (!want && gazeWin) {
    if (!gazeWin.isDestroyed()) gazeWin.destroy();
    gazeWin = null; gazeCam = false; calib = null; calibBusy = false; zones.reset();
  }
  const cal = want && gazeCals()[link.peer.id];
  zones.setCalibration(cal || null);
  pushGaze();
}
function gazeSample(s) {
  if (calib) { if (calib.target) calib.cal.add(calib.target, s); return; }
  const z = zones.update(s, Date.now());
  if (!z || !link) return;
  console.log('[island] gaze ->', z);
  gazeWant = z;
  applyGazeWant(Date.now());
}
// a switch that lands while typing waits until the keyboard has been quiet for a moment (at most 4 s, and only while still looking there)
let gazeWant = null, gazeRetry = null;
// After a calibration the first successful switch toward the other computer completes a test: once the screen-edge animation has played, the
// computer that just became active says that Look to switch works.
let gazeTestUntil = 0;
function finishGazeTest(toPeer) {
  gazeTestUntil = 0;
  setTimeout(() => {
    lifecycle.line('look to switch: test passed (' + (toPeer ? 'the pointer moved to the other computer' : 'back to this computer') + ')');
    if (toPeer) link.send({ t: 'notice', title: 'Look to switch is ready', text: 'It moved the pointer here: it works', kind: 'ok' });
    else toast('Look to switch is ready', 'It brought the pointer back: it works', 'ok');
  }, 1300); // the edge animation takes about a second
}
function applyGazeWant(since) {
  clearTimeout(gazeRetry);
  if (!gazeWant || !link) return;
  const r = gazeWant === 'peer' ? link.gazeEnter() : link.gazeLeave();
  if (r === 'busy' && Date.now() - since < 4000) { gazeRetry = setTimeout(() => applyGazeWant(since), 150); return; }
  if (r === true && gazeTestUntil > Date.now() && gazeWant === 'peer') finishGazeTest(true);
  gazeWant = null;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function calibrate() {
  // calibrating here means the person is at this computer: its camera is the one that must run (the other one closes)
  if (!calibBusy && !gazeCam && gazeOn() && link.peer) {
    gazeMine = true; gazeSuspended = false; gazeWakeUntil = Date.now() + 10 * 60 * 1000;
    await applyGaze();
    for (let i = 0; i < 40 && !gazeCam; i++) await wait(150);
  }
  if (calibBusy || !gazeCam || !link.peer) return;
  calibBusy = true;
  gazeWakeUntil = Date.now() + 10 * 60 * 1000; // asked for: the camera stays on
  gazeSuspended = false;
  const peerId = link.peer.id, steps = [['self', 'this screen'], ['peer', link.peer.name + "'s screen"]];
  const c = { cal: new Calibrator(), target: null };
  calib = c;
  const still = () => { if (calib !== c || !gazeCam) throw new Error('the camera closed before the calibration finished'); };
  try {
    for (const [target, label] of steps) {
      // both computers show the same step: a countdown with an animated ring, then a short "hold still" phase
      const here = target === 'self', READY = 3, HOLD = 2;
      const step = here ? 1 : 2;
      toast(here ? 'Look at this screen' : `Look at ${link.peer.name}`, 'Keep your head still', 'progress', { ready: READY, hold: HOLD, step, of: 2, glyph: here ? 'here' : 'there' });
      link.send({ t: 'notice', kind: 'progress', ready: READY, hold: HOLD, step, of: 2, glyph: here ? 'there' : 'here', title: here ? `Look at ${os.hostname()}` : 'Look at this screen', text: 'Keep your head still' });
      gazeMsg = `Look at ${label}`; pushGaze();
      await wait(READY * 1000); still();
      c.target = target; gazeMsg = `Keep looking at ${label}`; pushGaze();
      await wait(HOLD * 1000); still(); c.target = null;
    }
    const r = c.cal.finish();
    const peerName = link.peer ? link.peer.name : 'the other computer';
    if (r.ok) {
      store.set('gazeCal', { ...gazeCals(), [peerId]: r.cal }); gazeMsg = 'Calibrated';
      gazeTestUntil = Date.now() + 2 * 60 * 1000; // the next successful head-turn switch is the test
      toast('Calibration saved', 'Now look at ' + peerName + ' to try it', 'ok');
      try { link.onCalibrated(); } catch {}
      link.send({ t: 'notice', title: 'Calibration saved', text: 'Look at this screen to try Look to switch', kind: 'ok' });
    } else {
      gazeMsg = 'Calibration failed: ' + r.error;
      toast('Calibration failed', r.error, 'err');
      link.send({ t: 'notice', title: 'Calibration failed', text: `${os.hostname()}: ${r.error}`, kind: 'err' });
    }
  } catch (e) {
    gazeMsg = 'Calibration stopped: ' + e.message;
    toast('Calibration stopped', e.message, 'err');
    lifecycle.line('calibration stopped: ' + e.message);
  } finally { if (calib === c) calib = null; calibBusy = false; applyGaze(); }
}

process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));

// stadium-shaped menu bar icon (template image, so macOS tints it for light/dark)
function pillIcon() {
  const W = 44, H = 24, R = 12, buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = Math.min(W - R, Math.max(R, x));
    if ((x - cx) ** 2 + (y - R) ** 2 <= R * R) buf.writeUInt32LE(0xff000000, (y * W + x) * 4);
  }
  const img = nativeImage.createFromBitmap(buf, { width: W, height: H, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

let keepOpen = false, pinned = false;

// ---- arrange-screens window (where the cursor crosses between computers) ----
let arrangeWin = null;
function openArrange() {
  if (arrangeWin && !arrangeWin.isDestroyed()) { arrangeWin.show(); arrangeWin.focus(); return; }
  arrangeWin = new BrowserWindow({
    width: 940, height: 660, title: 'Arrange screens', backgroundColor: '#0b0f17', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'arrange-preload.js'), contextIsolation: true },
  });
  arrangeWin.loadFile(path.join(__dirname, 'arrange.html'));
  arrangeWin.on('closed', () => { arrangeWin = null; });
}
function pushLayout() {
  if (arrangeWin && !arrangeWin.isDestroyed()) arrangeWin.webContents.send('layout', link.layoutState());
}

// a click inside the island pins it open; a click anywhere outside releases it again
function closeIfPinnedOutside() {
  if (!pinned || !win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint(), b = win.getBounds();
  const d = screen.getPrimaryDisplay().bounds;
  if (p.x >= d.x + (d.width - islandSize.w) / 2 && p.x <= d.x + (d.width + islandSize.w) / 2 && p.y <= b.y + islandSize.h) return;
  pinned = false; sendWin('unpin');
}

function createTray() {
  let trayImg = null;
  if (MAC) trayImg = pillIcon();
  else { try { trayImg = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }); } catch {} if (!trayImg || trayImg.isEmpty()) trayImg = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }); }
  tray = new Tray(trayImg);
  tray.setToolTip('A-tuls');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Hide / show the pill (Ctrl+Alt+H)', click: () => togglePill() },
    { label: 'Show island', click: () => { pillOff = false; store.set('pillOff', false); gameHide = false; win.showInactive(); } },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  console.log('[island] starting');
  if (!instance.ok) {
    console.log('[island] another instance is already running - quitting this one');
    if (instance.running) { try { dialog.showMessageBoxSync({ type: 'info', title: 'A-tuls', message: 'A-tuls is already running.', detail: 'Look for it at the top of the screen (the pill) or in the system tray.' }); } catch {} }
    return app.quit();
  }
  if (instance.fallback) lifecycle.line('the usual data folder is held by a stuck leftover of an earlier run: using ' + instance.dir);
  if (instance.migratedFrom) lifecycle.line('settings taken over from the old data folder: ' + instance.migratedFrom);
  if (instance.merged && instance.merged.length) lifecycle.line('newer settings from ' + instance.merged.join(', ') + ' were merged back');
  if (process.platform === 'darwin') app.dock.hide();
  // `electron . --quit` from a second launch asks this instance to close itself properly (killing it can leave it stuck)
  app.on('second-instance', (_e, argv) => { if (argv.includes('--quit')) app.quit(); });
  createWindow();
  startGuardian();
  if (process.env.ISLAND_RECOVERED) { lifecycle.line('restarted by the watchdog after a freeze (' + process.env.ISLAND_RECOVERED + ')'); setTimeout(() => toast('A-tuls restarted', 'It had stopped answering and was restarted', 'err'), 5000); }

  diag = new Diag(app.getPath('userData'), process.platform === 'win32' ? 'PC (Windows)' : 'Mac', () => {
    const s = link ? link.status() : {};
    const lay = link && link.peer ? link.layoutState() : null;
    const r = (n) => Math.round(n);
    return {
      linked: s.connected, peer: s.peerName, state: s.state, owner: link && link.owner, edge: link && link.prefs.edgeResistance, guard: link && link.prefs.freelookGuard,
      screens: displaysList().map((d) => `${d.w}x${d.h}px ${r(d.mmw)}x${r(d.mmh)}mm`).join(' + '),
      layout: lay ? `this at (${r(lay.self.off.x)},${r(lay.self.off.y)}) mm, other at (${r(lay.peer.off.x)},${r(lay.peer.off.y)}) mm, other is on the ${s.peerSide}` : 'not linked',
    };
  });
  link = new Link({ diag, input, getDisplays: displaysList, store: protectedStore(store), downloadDir: path.join(app.getPath('downloads'), 'A-tuls') });
  let lastPin = '';
  link.on('status', (s) => { if (s.pin !== lastPin) { lastPin = s.pin; console.log('[island] pairing code', s.pin); } console.log('[island] link:', s.connected ? 'connected to ' + s.peerName : 'disconnected', s.state); sendWin('link', s); });
  link.on('transfer', (t) => {
    sendWin('transfer', t);
    // a banner under the pill when a file has arrived or gone out, like the one for a new connection
    if (t.done) toast(t.dir === 'in' ? 'File received' : 'Sent', (t.name || 'file') + (link.peerName ? (t.dir === 'in' ? ' from ' : ' to ') + link.peerName : ''), 'ok', { icon: t.dir === 'in' ? 'received' : 'sent' });
  });
  link.on('error', (m) => console.error('link:', m));
  // master mode: a Mac that is not the master swallows its real mouse and keyboard (Windows does it inside its hooks)
  link.on('master', (mm) => { if (lastMedia) sendWin('media', lastMedia); lifecycle.line('master: ' + (mm.on ? (mm.mine ? 'this computer' : 'the other computer') : 'off')); toast(mm.on ? (mm.mine ? 'This computer is the master' : 'The other computer is the master') : 'Master mode is off', mm.on ? (mm.mine ? 'The other computer ignores its own mouse and keyboard' : 'This computer follows its mouse and keyboard (Ctrl+Alt+M to take over)') : 'Both computers use their own mouse and keyboard', 'ok'); });
  if (MAC) setInterval(() => { try { native.setPhysicalBlock(link.lockedOut()); if (link.lockedOut()) native.reassertMouseFree(); } catch {} }, 400).unref();
  // Mac: while this Mac controls the other computer the buttons are also read straight from the hardware state, 60 times a second. The system-wide
  // hook and the overlay did not report clicks in this situation; a click that arrives another way too is dropped in onLocalButton.
  if (MAC) { const held = [false, false]; let btnTimer = null; const btnTick = () => { try { [0, 1].forEach((b) => { const d = native.macMouse.buttonHeld(b); if (d !== held[b]) { held[b] = d; if (d || true) { lifecycle.line('mouse button ' + (b + 1) + (d ? ' down' : ' up') + ' read from the hardware state'); link.onLocalButton(d, b + 1, 1); } } }); } catch {} };
    // 60 reads a second, but only while this Mac controls the other computer (the state changes are announced by the link)
    const btnSync = () => { const need = link.state === 'controlling'; if (need && !btnTimer) { btnTimer = setInterval(btnTick, 16); } else if (!need && btnTimer) { clearInterval(btnTimer); btnTimer = null; held[0] = held[1] = false; } };
    link.on('status', btnSync); btnSync(); }
  else { setInterval(() => { try { link.checkStuckButtons(); } catch {} }, 1000).unref(); app.on('will-quit', () => { try { link.releaseInjectedButtons(); } catch {} }); }
  ipcMain.handle('master:set', (_e, on, who) => { link.setMaster(!!on, who === 'peer' ? (link.peer && link.peer.id) : link.id); return link.status().master; });
  link.on('clip', applyRemoteClip);
  link.on('notice', (n) => { lifecycle.line('notice: ' + n.title + (n.text ? ' - ' + n.text : '')); toast(n.title, n.text, n.kind, { ready: n.ready, hold: n.hold, step: n.step, of: n.of, glyph: n.glyph }); });
  let wasLinked = false;
  link.on('status', (s) => {
    if (s.connected && !wasLinked) toast('Connected', `Linked with ${s.peerName}`);
    wasLinked = s.connected;
  });
  link.on('capture', setCapture);
  link.on('suppress-shot', () => { // dismiss the Mac's own screenshot UI: the shortcut was meant for the other computer
    let n = 0;
    const t = setInterval(() => { spawn('pkill', ['-x', 'screencaptureui']); if (++n > 12) clearInterval(t); }, 60);
  });
  if (native.highResTimer()) console.log('[island] 1 ms timer resolution');
  if (process.platform === 'win32') native.setCursorHidden(false); // repair cursors if a previous run died while they were hidden
  link.on('layout', pushLayout);
  link.on('capture', (on) => diag && diag.event('capture', { on }));
  ['display-added', 'display-removed', 'display-metrics-changed'].forEach((ev) => screen.on(ev, onDisplaysChanged));
  startHookWatchdog();
  if (MAC) createOverlay(); // Windows swallows local input inside its hooks and needs no overlay window (about 70 MB); it is made only if the hooks cannot be installed
  pollHover();
  pollMacDrop();
  link.start();
  gazeIdleWatch();
  setupSas();
  let edgeIdle = null;
  link.on('status', (s) => {
    clearTimeout(edgeIdle); edgeIdle = null;
    if (s.connected) edgefx.warm();
    else edgeIdle = setTimeout(() => edgefx.destroy(), 30000);
  });
  // only the screen that becomes the active one gets the effect (the pointer arrived, or came back to this computer)
  let lastImpact = 0;
  link.on('switch', (s) => {
    lastSwitchAt = Date.now();
    if (Date.now() - lastImpact > 250) { lastImpact = Date.now(); const v = soundVol(); if (v) sendWin('chime', { kind: 'impact', vol: v }); } // a small thud when the pointer arrives on this screen
    if (!store.get('edgeFx', true)) return;
    lifecycle.line(`edge effect: screen active, pointer from the ${s.edge || 'nearest'} edge`);
    setTimeout(() => edgefx.play({ kind: 'enter', edge: s.edge }), 70); // after the pointer has been placed
  });
  ipcMain.handle('fx:test', () => { edgefx.play({ kind: 'enter', edge: 'left' }); });
  // A link that ends (cable, Wi-Fi, sleep, or the other computer disconnecting) stays ended: nothing reconnects by itself. The person connects it
  // again from the Link tab (Recent: one click, no code).
  link.on('lost', (peer) => { lifecycle.line(`link ended: ${peer.name} (${peer.host})`); toast('Disconnected', `The link to ${peer.name} was lost`, 'err'); });
  radial.init({ store, link, toast, pickColor, saveColor, MAC });
  // other computers on this network that run A-tuls (shown in the Link tab)
  const { Discovery } = require('./discovery');
  const discovery = global.__discovery = new Discovery(() => ({ id: link.id, name: require('os').hostname(), plat: process.platform, port: link.status().port }));
  discovery.on('error', (e) => console.error('[island] discovery:', e));
  discovery.on('change', () => sendWin('nearby', discovery.list()));
  ipcMain.handle('link:nearby', () => discovery.list());
  discovery.start();
  console.log('[island] pairing code', link.pin); lastPin = link.pin;
  console.log('[island] ready, platform', process.platform, 'screens', JSON.stringify(displaysList()));
  if (process.env.ISLAND_AUTOCONNECT) { // debug helper: ISLAND_AUTOCONNECT=host,side connects with the saved pairing token
    const [host, side = 'bottom', pin = ''] = process.env.ISLAND_AUTOCONNECT.split(',');
    setTimeout(() => link.connect(host, pin, side).then(() => console.log('[island] autoconnect ok')).catch((e) => console.log('[island] autoconnect failed:', e.message)), 3000);
  }
  setTimeout(startInput, 1000); // after the window is up, so a permission stall can't hide the UI
  startClipboardSync();
  watchMacScreenshots();
  macTargetSync();
  pollMedia();

  ipcMain.on('ov-wheel', (_e, dx, dy, mode) => link.onOverlayWheel(dx, dy, mode));
  link.prefs = { edgeResistance: store.get('edgeResistance', 20), freelookGuard: store.get('freelookGuard', true), smoothWheel: store.get('smoothWheel', true), pointerSpeed: Math.min(3, Math.max(0.3, Number(store.get('pointerSpeed', 1)) || 1)) };
  ipcMain.handle('pointer:set', (_e, v) => { const n = Math.min(3, Math.max(0.3, Number(v) || 1)); link.prefs.pointerSpeed = n; store.set('pointerSpeed', n); lifecycle.line('settings: pointer speed ' + Math.round(n * 100) + '%'); return n; });
  ipcMain.handle('prefs:get', () => link.prefs);
  ipcMain.handle('prefs:set', (_e, edge, guard, smooth) => {
    link.prefs = { edgeResistance: Math.min(200, Math.max(0, Number(edge) || 0)), freelookGuard: !!guard, smoothWheel: smooth !== false, pointerSpeed: link.prefs.pointerSpeed };
    store.set('smoothWheel', link.prefs.smoothWheel);
    store.set('edgeResistance', link.prefs.edgeResistance);
    store.set('freelookGuard', link.prefs.freelookGuard);
    lifecycle.line(`settings: edge resistance ${link.prefs.edgeResistance}, game guard ${link.prefs.freelookGuard}, smooth wheel ${link.prefs.smoothWheel}`);
    syncOutFn(['edgeResistance', 'freelookGuard']);
  });
  link.scrollSettings = { speed: store.get('scrollSpeed', 1), reverse: store.get('scrollReverse', false), tpV: store.get('tpScrollV', 1), tpH: store.get('tpScrollH', 1) };
  ipcMain.handle('tpscroll:set', (_e, v, hz) => {
    link.scrollSettings.tpV = Math.min(4, Math.max(0.2, Number(v) || 1)); link.scrollSettings.tpH = Math.min(4, Math.max(0.2, Number(hz) || 1));
    store.set('tpScrollV', link.scrollSettings.tpV); store.set('tpScrollH', link.scrollSettings.tpH);
    lifecycle.line(`settings: Mac trackpad scroll up/down ${Math.round(link.scrollSettings.tpV * 100)}%, left/right ${Math.round(link.scrollSettings.tpH * 100)}%`);
    return link.scrollSettings;
  });
  ipcMain.handle('scroll:get', () => link.scrollSettings);
  // scroll tuning belongs to this computer only (it is never sent to the other one)
  const { cleanTune } = require('./smooth');
  link.scrollTune = cleanTune(store.get('scrollTune', {}));
  const ACTION_IDS = ['default', 'none', 'desktopLeft', 'desktopRight', 'missionControl', 'back', 'forward', 'pickColor', 'screenshot', 'radial'];
  link.buttonMap = store.get('buttonMap', {});
  ipcMain.handle('btnmap:get', () => link.buttonMap);
  // keyboard shortcuts of this computer (a combination -> an action), and the recorder the settings window uses to capture a combination
  link.hotkeys = HK.cleanHotkeys(store.get('hotkeys', []), KEY_NAMES, ACTION_IDS);
  ipcMain.handle('hotkeys:get', () => link.hotkeys);
  ipcMain.handle('hotkeys:set', (_e, list) => {
    link.hotkeys = HK.cleanHotkeys(list, KEY_NAMES, ACTION_IDS);
    store.set('hotkeys', link.hotkeys);
    lifecycle.line('settings: ' + link.hotkeys.length + ' keyboard shortcuts');
    return link.hotkeys;
  });
  ipcMain.handle('keys:record', () => new Promise((resolve) => { lifecycle.line('settings: recording a key combination'); link.startRecording((combo) => { lifecycle.line('settings: recorded ' + (combo || 'nothing (cancelled)')); resolve(combo); }); }));
  ipcMain.on('keys:cancel', () => link.stopRecording(null));
  ipcMain.handle('colors:get', () => store.get('colors', []));
  ipcMain.handle('colors:clear', () => { store.set('colors', []); sendWin('colors', []); return []; });
  ipcMain.handle('colors:pick', () => { pickColor(); });
  ipcMain.handle('colors:copy', (_e, v) => { if (/^#[0-9A-F]{6}$/i.test(v)) clipboard.writeText(v.toUpperCase()); });
  const { globalShortcut } = require('electron');
  // emergency exit: everything goes back to this computer (cursor shown, buttons and keys released, control released)
  try { globalShortcut.register('CommandOrControl+Alt+Shift+Escape', () => { console.log('[island] panic shortcut'); try { if (pickFinish) pickFinish(null); radial.close(); link.panic(); native.setCursorHidden(false); native.macMouse.hideCursor(false); toast('Control returned', 'Everything is back on this computer', 'ok'); } catch (e) { console.error('[island] panic failed:', e.message); } }); } catch (e) { console.error('[island] panic shortcut failed:', e.message); }
  try { globalShortcut.register('CommandOrControl+Alt+H', togglePill); } catch {}
  try { globalShortcut.register('Control+Alt+M', () => { if (link.sock) link.setMaster(true, link.id); }); } catch {}
  pillOff = !!store.get('pillOff', false); watchGames(); if (pillOff) setTimeout(applyPillVisible, 3000);
  const sc = 'CommandOrControl+Alt+P';
  try { console.log('[island] shortcut', sc, globalShortcut.register(sc, () => { console.log('[island] shortcut pressed'); pickColor(); }) ? 'registered' : 'NOT registered (taken by another app)'); } catch (e) { console.error('[island] shortcut failed:', e.message); }
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
  ipcMain.handle('btnmap:set', (_e, map) => {
    const out = {};
    for (const k of ['tiltLeft', 'tiltRight', 'back', 'forward', 'chord', 'middle']) {
      const v = map && map[k];
      out[k] = ACTION_IDS.includes(v) ? v : HK.isKeysAction(v) && HK.normalCombo(v.slice(5), KEY_NAMES) ? 'keys:' + HK.normalCombo(v.slice(5), KEY_NAMES) : 'default';
    }
    link.buttonMap = out; store.set('buttonMap', out); return out;
  });
  link.on('pick-color', () => pickColor());
  ipcMain.handle('tune:get', () => link.scrollTune);
  ipcMain.handle('tune:set', (_e, t) => { link.scrollTune = cleanTune(t); store.set('scrollTune', link.scrollTune); lifecycle.line(`settings: scroll tuning step ${link.scrollTune.step} px, speed ${link.scrollTune.speed}x, duration ${link.scrollTune.duration} ms`); return link.scrollTune; });
  ipcMain.handle('scroll:set', (_e, speed, reverse) => {
    link.scrollSettings = { ...link.scrollSettings, speed: Math.min(4, Math.max(0.2, Number(speed) || 1)), reverse: !!reverse };
    store.set('scrollSpeed', link.scrollSettings.speed);
    store.set('scrollReverse', link.scrollSettings.reverse);
    lifecycle.line(`settings: scroll speed ${Math.round(link.scrollSettings.speed * 100)}%, reverse ${link.scrollSettings.reverse}`);
  });
  ipcMain.on('ov-btn', (_e, down, domBtn, n) => { const b = [1, 3, 2, 4, 5][domBtn]; if (b && link.state === 'controlling') { if (down) lifecycle.line('mouse button ' + b + ' down seen by the overlay'); link.onLocalButton(!!down, b, n || 1); } });
  // Mac: while a button is held (a drag: selecting text, a screenshot region, resizing) the overlay's pointer lock reports no movement, so the movement
  // comes from a listen-only tap on the real mouse instead; the overlay's own is ignored meanwhile so nothing is counted twice
  ipcMain.on('ov-move', (_e, dx, dy) => { if (!link.buttonsDown.size) link.onRelMove(dx, dy); });
  if (MAC) link.tapStats = () => native.macMouse.deltaTapStats();
  if (MAC) link.on('capture', (on) => { native.macMouse.deltaTap(on, on ? (dx, dy) => { if (link.buttonsDown.size) link.onRelMove(dx, dy); } : null); });
  link.on('lockfail', () => { console.log('[island] pointer lock gave no movement, using cursor tracking instead'); overlay && overlay.webContents.executeJavaScript('document.exitPointerLock && document.exitPointerLock()', true).catch(() => {}); });
  ipcMain.on('ov-lock', (_e, v) => { if (v) { link.relMoves = 0; link.hookMovesLocked = 0; link.relIgnoreUntil = Date.now() + 600; } link.locked = !!v; console.log('[island] pointer lock', v ? 'on' : 'off');
    // The pointer lock can be lost while this Mac controls the other computer (the overlay loses the focus: a notification, another app...). The Mac's
    // pointer is then free again and runs into the edge of the Mac's own screen, which feels like an invisible block. Take the lock again at once
    // (at most 6 tries in 3 seconds, so a refusal does not turn into a loop).
    if (!v && MAC && link.state === 'controlling' && overlay && !overlay.isDestroyed()) {
      const now = Date.now(); relockTries = relockTries.filter((t) => now - t < 3000);
      if (relockTries.length < 6) { relockTries.push(now); setTimeout(() => { if (link.state !== 'controlling' || !overlay || overlay.isDestroyed() || link.locked) return; try { app.focus({ steal: true }); overlay.focus(); } catch {} overlay.webContents.executeJavaScript('document.body.requestPointerLock()', true).catch(() => {}); lifecycle.line('pointer lock lost while controlling: taken again'); }, 60); }
    }
  });
  ipcMain.handle('diag:report', () => { diag.writeSummary(); return diag.summary(); });
  ipcMain.handle('diag:open', () => { diag.writeSummary(); shell.showItemInFolder(diag.summaryFile); });
  // a command file lets a script ask this app to stop itself properly (a hard kill can leave a hung process that holds the mouse hooks)
  const cmdFile = path.join(app.getPath('userData'), 'control.cmd');
  try { require('fs').unlinkSync(cmdFile); } catch {}
  setInterval(() => {
    try {
      const fs = require('fs');
      if (!fs.existsSync(cmdFile)) return;
      const c = fs.readFileSync(cmdFile, 'utf8').trim();
      fs.unlinkSync(cmdFile);
      // the installed app answers only the harmless commands; the test commands (typing, pairing, settings changes) exist for development runs
      if (app.isPackaged && !/^(quit|restart|selftest|fx|splash)$/.test(c)) { lifecycle.line('control command ignored in the installed app: ' + c.split(':')[0]); return; }
      lifecycle.line('control command: ' + c);
      if (c.startsWith('connect:')) { (() => { const h = c.split(':')[1]; const near = global.__discovery && global.__discovery.list().find((n) => n.host === h); return link.connect(h, '', 'right', null, near && near.port); })().then(() => lifecycle.line('connect: connected with the saved token')).catch((e) => lifecycle.line('connect failed: ' + e.message)); }
      else if (c === 'sharing:off' || c === 'sharing:on') { store.set('clipboard', c === 'sharing:on'); lifecycle.line('test: clipboard sharing ' + c.slice(8)); }
      else if (c === 'perf:shotui') { (async () => { const w = new BrowserWindow({ show: false, width: 940, height: 680, webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: false } }); await w.loadFile(path.join(__dirname, 'settings.html')); await new Promise((r) => setTimeout(r, 2000)); const r = await w.webContents.executeJavaScript("(async () => { const out = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); try { document.querySelector('aside button[data-p=sharing]').click(); await sleep(500); const num = document.querySelector('#main input[type=number]'); out.push('number input: ' + (num ? 'found value=' + num.value + ' disabled=' + num.disabled + ' readonly=' + num.readOnly : 'MISSING')); const sel = Array.from(document.querySelectorAll('#main select')).find((x) => Array.from(x.options).some((o) => o.value === 'jpg')); out.push('format select: ' + (sel ? 'found value=' + sel.value + ' disabled=' + sel.disabled : 'MISSING')); const state0 = await window.api.shotGet(); if (num) { num.value = '640'; num.dispatchEvent(new Event('change', { bubbles: true })); await sleep(800); } const s1 = await window.api.shotGet(); out.push('after typing 640 + change: backend limit=' + s1.limitMb); const num2 = document.querySelector('#main input[type=number]'); out.push('after redraw the field shows ' + (num2 && num2.value)); if (sel) { sel.value = 'jpg'; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(800); } const s2 = await window.api.shotGet(); out.push('after choosing jpg: backend format=' + s2.format); await window.api.shotSet({ limitMb: state0.limitMb, format: state0.format }); } catch (e) { out.push('ERROR ' + e.message); } return out.join(' | '); })()"); lifecycle.line('shot ui probe: ' + r); w.destroy(); })().catch((e) => lifecycle.line('shot ui probe failed: ' + e.message)); }
      else if (c.startsWith('sync:')) { const [, k, v] = c.split(':'); lifecycle.line('test: ' + syncTest(k, v)); }
      else if (c === 'perf:shottype') { (async () => { const w = new BrowserWindow({ show: true, x: -3000, y: -3000, width: 940, height: 680, focusable: true, webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: false } }); await w.loadFile(path.join(__dirname, 'settings.html')); await new Promise((r) => setTimeout(r, 2000)); const js = (t) => w.webContents.executeJavaScript(t); await js("document.querySelector('aside button[data-p=sharing]').click()"); await new Promise((r) => setTimeout(r, 600)); const before = await js("(() => { const n = document.querySelector('#main input[type=number]'); n.focus(); n.select(); return n.value + ' focused=' + (document.activeElement === n); })()"); w.webContents.focus(); await w.webContents.insertText('1000'); await new Promise((r) => setTimeout(r, 300)); const typed = await js("document.querySelector('#main input[type=number]').value"); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await js("document.querySelector('#main input[type=number]').blur()"); await new Promise((r) => setTimeout(r, 900)); const after = await js("(async () => { const st = await window.api.shotGet(); const n = document.querySelector('#main input[type=number]'); return 'backend=' + st.limitMb + ' field=' + (n && n.value); })()"); lifecycle.line('shot typing probe: before ' + before + ' | after typing field=' + typed + ' | after Enter/blur: ' + after); await js("window.api.shotSet({ limitMb: 500 })"); w.destroy(); })().catch((e) => lifecycle.line('shot typing probe failed: ' + e.message)); }
      else if (c.startsWith('caltest:')) { require('./calendar').add('Test', c.slice(8)).then((r) => lifecycle.line('caltest: ' + JSON.stringify(r))); }
      else if (c.startsWith('fakemedia:')) { const [title, artist, pos, end, status] = c.slice(10).split('|'); fakeMediaUntil = Date.now() + 120000; sendWin('media', { title, artist, status: status || 'Playing', canPrev: true, canNext: true, pos: Number(pos) || 0, end: Number(end) || 0, thumb: '' }); lifecycle.line('test: made-up media ' + title); }
      else if (c.startsWith('faketransfer:')) { const [name, mb] = c.slice(13).split('|'); const size = (Number(mb) || 12) * 1048576; let p = 0; sendWin('transfer', { dir: 'out', name, pct: 0, size }); const iv = setInterval(() => { p += 8; if (p >= 100) { clearInterval(iv); sendWin('transfer', { dir: 'out', name, pct: 100, done: true, size }); toast('Sent', name + ' to test', 'ok', { icon: 'sent' }); } else sendWin('transfer', { dir: 'out', name, pct: p, size }); }, 600); }
      else if (c === 'fakemedia-off') { fakeMediaUntil = 0; sendWin('media', {}); }
      else if (c.startsWith('island:js:')) { if (win) win.webContents.executeJavaScript(c.slice(10)).catch(() => {}); }
      else if (c.startsWith('island:eval:')) { if (win) win.webContents.executeJavaScript(c.slice(12)).then((r) => lifecycle.line('eval: ' + JSON.stringify(r))).catch((e) => lifecycle.line('eval failed: ' + e.message)); }
      else if (c === 'enterpeer') lifecycle.line('test: enter peer -> ' + link.gazeEnter());
      else if (c === 'leavepeer') lifecycle.line('test: leave peer -> ' + link.gazeLeave());
      else if (c === 'ovclick') { if (overlay && !overlay.isDestroyed()) { for (const t of ['mouseDown', 'mouseUp']) overlay.webContents.sendInputEvent({ type: t, x: 200, y: 200, button: 'left', clickCount: 1 }); lifecycle.line('test: synthetic click sent to the overlay (link state ' + link.state + ')'); } else lifecycle.line('test: no overlay'); }
      else if (c === 'assoctest') { hookLogUntil = Date.now() + 16000; lifecycle.line('test: mouse disconnected from the cursor for 14 s: ' + native.macAssociate(false)); setTimeout(() => lifecycle.line('test: mouse connected again: ' + native.macAssociate(true)), 14000); }
      else if (c === 'radialtest') radial.open('test');
      else if (c.startsWith('wafake:')) { const [title, text, from] = c.slice(7).split('|'); waAdd([{ k: 'fake_' + Date.now(), chat: 'fake_' + title, title, from: from || '', text: text || '', at: Date.now(), group: !!from }]); lifecycle.line('test: fake WhatsApp message added'); } // development test: a made-up message on the WhatsApp page
      else if (c === 'wareset') { waItems = []; waSave(); notifier.stop(); notifier.lastId = 0; if (waOn) notifier.start(); waPush(); lifecycle.line('test: WhatsApp list emptied and read again'); } // development test: forget the list and read the notifications again (silently)
      else if (c === 'toastreply') { toast('Budi', 'Halo, sudah makan belum?', 'ok', { icon: 'chat', reply: { chat: '1@lid', preview: 'Halo' } }); lifecycle.line('test: message banner with a reply field shown'); } // development test: the banner with a field to answer in
      else if (c === 'waterring') { water.ring(); waterSave(); lifecycle.line('test: water reminder rung'); }
      else if (c === 'reinstallhooks') reinstallInput('test'); // development test: our hooks go above uiohook, like after an unlock
      else if (c.startsWith('settingsjs:')) radial.evalSettings(c.slice(11)).then((r) => lifecycle.line('test: settings says ' + JSON.stringify(r))).catch((e) => lifecycle.line('test: settings failed ' + e.message));
      else if (c === 'wins') lifecycle.line('test: windows ' + BrowserWindow.getAllWindows().map((w) => { const b = w.getBounds(); return (w.webContents.getURL().split('/').pop() || '?') + ' ' + (w.isVisible() ? 'visible' : 'hidden') + (w.isFocused() ? ' focused' : '') + (w.isMinimized() ? ' minimized' : '') + ' ' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height; }).join(' | '));
      else if (c.startsWith('linkicon:')) { const t0 = Date.now(); radial.itemIcon({ kind: 'url', url: c.slice(9) }).then((u) => lifecycle.line('test: link icon ' + c.slice(9) + ' -> ' + (u ? u.length + ' chars' : 'none') + ' in ' + (Date.now() - t0) + ' ms')); }
      else if (c === 'unlock') { if (overlay && !overlay.isDestroyed()) overlay.webContents.executeJavaScript('document.exitPointerLock && document.exitPointerLock()', true).catch(() => {}); } // test: lose the pointer lock
      else if (c.startsWith('movetest:')) { // takes control, moves the other computer's pointer n steps of (dx,dy), gives control back
        const [dx, dy, n, gap] = c.slice(9).split(',').map(Number);
        (async () => { const sl = (ms) => new Promise((r) => setTimeout(r, ms)); const ok = link.gazeEnter(); lifecycle.line('test: move enter ' + ok); if (ok !== true) return; await sl(700); for (let i = 0; i < n; i++) { link.queueMove(dx, dy); await sl(gap || 20); } await sl(500); lifecycle.line('test: move leave ' + link.gazeLeave()); })();
      }
      else if (c === 'dragtest') { // takes control, presses the left button on the other computer, drags 300 px to the right, lets go, gives control back
        (async () => { const sl = (ms) => new Promise((r) => setTimeout(r, ms)); const ok = link.gazeEnter(); lifecycle.line('test: drag enter ' + ok); if (ok !== true) return; await sl(700); link.send({ t: 'down', b: 1, n: 1 }); await sl(200); for (let i = 0; i < 30; i++) { link.queueMove(10, 0); await sl(30); } await sl(300); link.send({ t: 'up', b: 1 }); await sl(400); lifecycle.line('test: drag leave ' + link.gazeLeave()); })();
      }
      else if (c === 'holdtest') { // Mac: takes control and drags like a hand does: real button-down and drag events at the frozen cursor, 300 px to the right, then lets go
        (async () => { const sl = (ms) => new Promise((r) => setTimeout(r, ms)); const ok = link.gazeEnter(); lifecycle.line('test: hold enter ' + ok); if (ok !== true) return; await sl(900); const p = screen.getCursorScreenPoint(); native.macMouse.down(1, p.x, p.y, 1); await sl(250); for (let i = 1; i <= 30; i++) { native.macMouse.move(p.x + i * 10, p.y, 1); await sl(30); } await sl(300); native.macMouse.up(1, p.x + 300, p.y, 1); await sl(500); native.macMouse.move(p.x, p.y, 0); lifecycle.line('test: hold leave ' + link.gazeLeave()); })();
      }
      else if (c === 'procs') { // which window lives in which process, with its CPU and memory (for measuring)
        const wins = Object.fromEntries(BrowserWindow.getAllWindows().map((w) => { try { return [w.webContents.getOSProcessId(), (w.webContents.getURL().split('/').pop() || '?') + (w.isVisible() ? '' : ' (hidden)')]; } catch { return [0, '?']; } }));
        lifecycle.line('test: procs ' + app.getAppMetrics().map((p) => `${p.pid} ${p.type}${wins[p.pid] ? ' ' + wins[p.pid] : ''} cpu ${p.cpu.percentCPUUsage.toFixed(1)}% mem ${Math.round(p.memory.workingSetSize / 1024)}MB`).join(' | '));
      }
      else if (c === 'layoutdump') lifecycle.line('test: layout ' + JSON.stringify(link.layoutState()));
      else if (c === 'cursorpos') lifecycle.line('test: cursor at ' + JSON.stringify(screen.getCursorScreenPoint()));
      else if (c.startsWith('setpos:')) { const [x, y] = c.slice(7).split(',').map(Number); input.setPos(x, y); setTimeout(() => lifecycle.line('test: cursor after setpos ' + JSON.stringify(screen.getCursorScreenPoint())), 200); }
      else if (c === 'calibrated') link.onCalibrated();
      else if (c === 'master:auto') link.adoptMaster({ on: true, id: '', auto: true, calMaster: false, at: 0 });
      else if (c === 'master:me') link.setMaster(true, link.id);
      else if (c === 'master:peer') link.setMaster(true, link.peer && link.peer.id);
      else if (c === 'master:off') link.setMaster(false);
      else if (c === 'island:shot') { if (win) win.webContents.capturePage().then((img) => { fs.writeFileSync(path.join(app.getPath('userData'), 'island-shot.png'), img.toPNG()); lifecycle.line('test: island picture saved'); }).catch((e) => lifecycle.line('island shot failed: ' + e.message)); }
      else if (c === 'island:open' || c === 'island:close') { if (win) win.webContents.send('hover', c === 'island:open'); }
      else if (c === 'gazetest:done') finishGazeTest(true);
      else if (c.startsWith('hang:')) { const ms = Number(c.slice(5)) || 20000; lifecycle.line('test: freezing the main thread for ' + ms + ' ms'); const end = Date.now() + ms; while (Date.now() < end) { /* frozen on purpose */ } }
      else if (c === 'perf:pointerorder') { (async () => { const w = new BrowserWindow({ show: false, width: 940, height: 680, webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: false } }); await w.loadFile(path.join(__dirname, 'settings.html')); await new Promise((r) => setTimeout(r, 2000)); const r = await w.webContents.executeJavaScript("(async () => { document.querySelector('aside button[data-p=pointer]').click(); await new Promise((r) => setTimeout(r, 400)); return Array.from(document.querySelectorAll('#main .row .t b, #main .group')).map((e) => e.innerText).join(' | '); })()"); lifecycle.line('pointer page order: ' + r); w.destroy(); })().catch((e) => lifecycle.line('order probe failed: ' + e.message)); }
      else if (c === 'gaze:on' || c === 'gaze:off') { store.set('gazeOn', c === 'gaze:on'); if (c === 'gaze:on') { gazeWakeUntil = Date.now() + 10 * 60 * 1000; gazeSuspended = false; } applyGaze(); lifecycle.line('test: look to switch ' + c.slice(5) + ', camera window ' + (gazeWin ? 'open' : 'closed') + ', idle ' + powerMonitor.getSystemIdleTime() + ' s'); }
      else if (c === 'gaze:state') lifecycle.line('test: camera permission=' + systemPreferences.getMediaAccessStatus('camera') + ' gaze on=' + gazeOn() + ' camera=' + gazeCam + ' window=' + !!gazeWin + ' suspended=' + gazeSuspended + ' idle=' + powerMonitor.getSystemIdleTime() + ' s');
      else if (c.startsWith('media:')) { lifecycle.line('media command ' + c + ': ' + (mediaSend ? mediaSend(c.slice(6)) : 'no helper')); }
      else if (c === 'perf:probe') win.webContents.executeJavaScript("JSON.stringify({ anims: document.getAnimations().map((a) => a.animationName || a.transitionProperty || a.constructor.name), pill: document.getElementById('pill-text').className + '|' + document.getElementById('pill-text').textContent, playing: typeof playing === 'undefined' ? null : playing, hidden: document.hidden, prevIcon: document.getElementById('prev').dataset.icon, nextIcon: document.getElementById('next').dataset.icon, prevTitle: document.getElementById('prev').title, calText: document.getElementById('nook-cal-text').textContent, gazeRowHidden: document.getElementById('nook-gaze').hidden, gazeSwOn: document.getElementById('nook-gaze-sw').classList.contains('on'), linkBtn: !!document.getElementById('nook-link') })").then((r) => lifecycle.line('perf probe: ' + r)).catch((e) => lifecycle.line('perf probe failed: ' + e.message));
      else if (c === 'perf:hidepill') win.hide();
      else if (c === 'perf:showpill') win.showInactive();
      else if (c === 'perf:noedge') edgefx.destroy();
      else if (c === 'disconnect') link.disconnect();
      else if (c === 'shot') link.shoot();
      else if (c === 'shotself') shotSelfTest();
      else if (c === 'shottest') shotTest();
      else if (c.startsWith('colors:')) { const [, a, b] = c.split(':'); setSplashColors(a, b); }
      else if (c.startsWith('hotkey:')) { const [, combo, action] = c.split(':'); link.hotkeys = HK.cleanHotkeys([{ combo, action }], KEY_NAMES, ACTION_IDS); lifecycle.line('test hotkey set: ' + JSON.stringify(link.hotkeys)); }
      else if (c === 'splash') splash.play({ enabled: true, pillCenterY: barH() / 2, colors: store.get('splashColors', {}) });
      else if (c === 'sasyes' || c === 'sasno') lifecycle.line('sas answer by command: ' + link.sasAnswer(c === 'sasyes'));
      else if (c.startsWith('pair:')) { const [, h, p] = c.split(':'); link.connect(h, p, 'right', null, undefined, true).then(() => lifecycle.line('pair: connected')).catch((e) => lifecycle.line('pair failed: ' + e.message)); }
      else if (c === 'filetest') {
        const f = require('path').join(require('os').tmpdir(), 'island-filetest.txt');
        require('fs').writeFileSync(f, 'a-tuls file test ' + new Date().toISOString() + ' ' + 'x'.repeat(600000));
        link.sendFile(f).then(() => lifecycle.line('filetest: sent ' + require('crypto').createHash('md5').update(require('fs').readFileSync(f)).digest('hex'))).catch((e) => lifecycle.line('filetest failed: ' + e.message));
      } else if (c === 'keysink') keySink();
      else if (c.startsWith('keytest')) link.injectTest(c.includes(':') ? c.split(':')[1].split(',') : ['F24'], !c.includes(':')).then((r) => lifecycle.line('keytest: ' + r)).catch((e) => lifecycle.line('keytest failed: ' + e.message));
      else if (c === 'fx') edgefx.play({ kind: 'enter', edge: 'left' });
      else if (c === 'selftest') selfTest();
      else if (c === 'quit') app.quit();
      else if (c === 'restart') { app.relaunch(); app.quit(); }
    } catch {}
  }, 1000);
  // the run log: everything that happened, in one file (UI actions come from the windows)
  ipcMain.on('log:ui', (_e, text) => lifecycle.line('ui: ' + String(text).slice(0, 300)));
  ipcMain.handle('log:tail', () => lifecycle.tail(400));
  ipcMain.handle('log:open', () => { shell.showItemInFolder(lifecycle.file); });
  // start with the computer (the installed app; a development run never registers itself)
  if (app.isPackaged && !store.get('startupInit', false)) { try { app.setLoginItemSettings({ openAtLogin: true }); } catch {} store.set('startupInit', true); lifecycle.line('start with the computer: switched on (first run)'); }
  const startupState = () => ({ lyrics: store.get('lyrics', true), packaged: app.isPackaged, openAtLogin: !!app.getLoginItemSettings().openAtLogin, splash: store.get('splash', true), splashColors: store.get('splashColors', {}), radialOn: store.get('radialOn', true) !== false, edgeFx: store.get('edgeFx', true), version: app.getVersion(), sound: store.get('sound', true), soundVol: store.get('soundVol', 60), gameHide: store.get('gameHide', true), pillOff: !!store.get('pillOff', false) });
  // the animation colours: stamped with the time, kept here and sent to the other computer, which keeps the newer ones
  const setSplashColors = (c1, c2) => {
    const ok = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : '');
    store.set('splashColors', { c1: ok(c1), c2: ok(c2), t: Date.now() });
    lifecycle.line('settings: start-up animation colours ' + JSON.stringify(store.get('splashColors')));
    if (SYNC_SETTINGS) link.send({ t: 'fxcolors', colors: store.get('splashColors') });
  };
  ipcMain.handle('startup:get', startupState);
  ipcMain.handle('startup:set', (_e, o) => {
    if (o && typeof o.openAtLogin === 'boolean' && app.isPackaged) { try { app.setLoginItemSettings({ openAtLogin: o.openAtLogin }); } catch (e) { console.error('[island] login item failed:', e.message); } lifecycle.line('settings: start with the computer ' + o.openAtLogin); }
    if (o && typeof o.splash === 'boolean') { store.set('splash', o.splash); syncOutFn(['splash']); lifecycle.line('settings: start-up animation ' + o.splash); }
    if (o && o.splashColors && typeof o.splashColors === 'object') setSplashColors(o.splashColors.c1, o.splashColors.c2);
    if (o && typeof o.gameHide === 'boolean') { store.set('gameHide', o.gameHide); lifecycle.line('settings: hide in games ' + o.gameHide); if (!o.gameHide) { gameHide = false; applyPillVisible(); } }
    if (o && typeof o.pillOff === 'boolean' && o.pillOff !== pillOff) togglePill();
    if (o && typeof o.sound === 'boolean') { store.set('sound', o.sound); lifecycle.line('settings: notification sounds ' + o.sound); }
    if (o && Number.isFinite(Number(o.soundVol)) && o.soundVol !== undefined) store.set('soundVol', Math.max(0, Math.min(100, Math.round(Number(o.soundVol)))));
    if (o && typeof o.radialOn === 'boolean') { radial.setEnabled(o.radialOn); lifecycle.line('settings: radial menu ' + (o.radialOn ? 'on' : 'off')); }
    if (o && typeof o.lyrics === 'boolean') { store.set('lyrics', o.lyrics); lifecycle.line('settings: lyrics in the pill ' + o.lyrics); }
    if (o && typeof o.edgeFx === 'boolean') { store.set('edgeFx', o.edgeFx); syncOutFn(['edgeFx']); lifecycle.line('settings: screen-edge effect ' + o.edgeFx); }
    return startupState();
  });
  ipcMain.handle('sound:test', (_e, kind) => { sendWin('chime', { kind: String(kind || 'ok'), vol: Math.max(0, Math.min(100, Number(store.get('soundVol', 60)))) }); });
  ipcMain.handle('splash:test', () => { sendWin('chime', { kind: 'start', vol: store.get('sound', true) ? Math.max(0, Math.min(100, Number(store.get('soundVol', 60)))) : 0 }); splash.play({ enabled: true, pillCenterY: barH() / 2, colors: store.get('splashColors', {}) }); });
  const colorOk = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : '');
  // Settings that mean the same on both computers follow each other: a change made on one is sent to the other (the newer change wins, by time),
  // and when the link comes up both send what they have. Things that belong to one computer (folders, applications, mouse buttons, keyboard
  // shortcuts, scroll feel, camera calibration) are never sent.
  const SYNC = {
    splash: { get: () => store.get('splash', true), set: (v) => store.set('splash', !!v) },
    edgeFx: { get: () => store.get('edgeFx', true), set: (v) => store.set('edgeFx', !!v) },
    edgeResistance: { get: () => store.get('edgeResistance', 20), set: (v) => { const n = Math.min(200, Math.max(0, Number(v) || 0)); store.set('edgeResistance', n); link.prefs.edgeResistance = n; } },
    freelookGuard: { get: () => store.get('freelookGuard', true), set: (v) => { store.set('freelookGuard', !!v); link.prefs.freelookGuard = !!v; } },
    clipboard: { get: () => store.get('clipboard', true), set: (v) => store.set('clipboard', !!v) },
    gazeOn: { get: () => store.get('gazeOn', false), set: (v) => { store.set('gazeOn', !!v); if (v) { gazeWakeUntil = Date.now() + 10 * 60 * 1000; gazeSuspended = false; } applyGaze(); } },
    shotSave: { get: () => store.get('shotSave', false), set: (v) => { if (v && !shotDir()) store.set('shotDir', path.join(app.getPath('pictures'), 'A-tuls Screenshots')); store.set('shotSave', !!v); macTargetSync(); } },
    shotFormat: { get: () => store.get('shotFormat', 'png'), set: (v) => { if (v === 'png' || v === 'jpg') store.set('shotFormat', v); } },
    shotLimitMb: { get: () => store.get('shotLimitMb', 500), set: (v) => { if (Number(v) >= 1) store.set('shotLimitMb', Math.min(100000, Math.round(Number(v)))); } },
    shotOther: { get: () => store.get('shotOther', true), set: (v) => store.set('shotOther', !!v) },
  };
  // Every setting belongs to the computer it was set on: nothing is copied to the other computer or taken from it (this used to follow the other one).
  const SYNC_SETTINGS = false;
  const syncOut = (keys) => {
    if (!SYNC_SETTINGS) return;
    const stamps = store.get('syncStamps', {}), now = Date.now(), items = [];
    for (const k of keys) { if (!SYNC[k]) continue; stamps[k] = now; items.push({ k, v: SYNC[k].get(), t: now }); }
    store.set('syncStamps', stamps);
    if (items.length) link.send({ t: 'sync', items });
  };
  const syncAll = () => { if (!SYNC_SETTINGS) return; const stamps = store.get('syncStamps', {}); const items = Object.keys(stamps).filter((k) => SYNC[k]).map((k) => ({ k, v: SYNC[k].get(), t: stamps[k] })); if (items.length) link.send({ t: 'sync', items }); };
  link.on('sync', (items) => {
    if (!SYNC_SETTINGS || !Array.isArray(items)) return;
    const stamps = store.get('syncStamps', {});
    const took = [];
    for (const it of items.slice(0, 20)) {
      if (!it || !SYNC[it.k] || !(Number(it.t) > (stamps[it.k] || 0)) || it.v === undefined) continue;
      try { SYNC[it.k].set(it.v); stamps[it.k] = Number(it.t); took.push(it.k); } catch (e) { lifecycle.line('settings sync failed for ' + it.k + ': ' + e.message); }
    }
    if (took.length) { store.set('syncStamps', stamps); lifecycle.line('settings taken over from the other computer: ' + took.join(', ')); sendWin('startup', startupState()); }
  });
  link.on('layout', syncAll);
  syncOutFn = syncOut;
  syncTest = (k, raw) => { if (!SYNC[k]) return 'unknown key'; const v = raw === 'true' ? true : raw === 'false' ? false : /^d+$/.test(raw) ? Number(raw) : raw; SYNC[k].set(v); syncOut([k]); return 'sent ' + k + '=' + v; };
  link.on('fxcolors', (c) => {
    if (!SYNC_SETTINGS || !c || typeof c !== 'object') return;
    const mine = store.get('splashColors', {});
    const t = Number(c.t) || 0;
    if (!t || t <= (mine.t || 0)) return;
    store.set('splashColors', { c1: colorOk(c.c1), c2: colorOk(c.c2), t });
    lifecycle.line('animation colours taken over from the other computer: ' + JSON.stringify(store.get('splashColors')));
    sendWin('startup', startupState());
  });
  link.on('layout', () => { const c = store.get('splashColors', null); if (SYNC_SETTINGS && c && (c.c1 || c.c2)) link.send({ t: 'fxcolors', colors: { ...c, t: c.t || 1 } }); });
  ipcMain.on('keep-open', (_e, v) => { keepOpen = !!v; });
  ipcMain.on('island-size', (_e, w, h) => { islandSize = { w, h }; if (!MAC && win && !win.isDestroyed()) win.setIgnoreMouseEvents(h <= 40); });
  ipcMain.on('window-size', (_e, w, h) => {
    if (!MAC) { shapeWindow(w, h); return; }
    const d = screen.getPrimaryDisplay().bounds;
    win.setBounds({ x: pillLeft(w), y: d.y, width: w, height: h });
    if (MAC) console.log('[island] window now', JSON.stringify(win.getBounds()), 'wanted', w, h);
  });
  ipcMain.handle('metrics', () => ({ bar: barH(), notch: MAC && barH() >= 30, pos: store.get('pillPos', 'center') }));
  ipcMain.handle('layout:get', () => link.layoutState());
  ipcMain.handle('layout:set', (_e, id, x, y) => link.setOffset(id, x, y));
  ipcMain.handle('link:set-side', (_e, side) => { lifecycle.line('ui: other computer placed ' + side); return link.setSide(side); });
  ipcMain.on('open-arrange', openArrange);
  ipcMain.on('pin', (_e, v) => { pinned = !!v; });
  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('gaze:get', () => gazeStatus());
  ipcMain.handle('gaze:set', (_e, v) => { lifecycle.line('settings: look to switch ' + (v ? 'on' : 'off')); store.set('gazeOn', !!v); syncOutFn(['gazeOn']); gazeMsg = ''; if (v) { gazeWakeUntil = Date.now() + 10 * 60 * 1000; gazeSuspended = false; } applyGaze(); });
  ipcMain.handle('gaze:preview', (_e, v) => setPreview(v));
  ipcMain.handle('gaze:calibrate', () => { calibrate(); });
  ipcMain.on('gaze:sample', (_e, s) => gazeSample(s));
  ipcMain.on('gaze:state', (_e, st) => { gazeCam = !!st.on; lifecycle.line('look to switch: camera page says ' + JSON.stringify(st)); if (st.error) { gazeError = st.error; store.set('gazeOn', false); applyGaze(); } pushGaze(); });
  link.on('status', () => { const id = link.peer && link.peer.id; if (id !== gazeActivePeer) { gazeActivePeer = id; applyGaze(); } });
  ipcMain.handle('link:status', () => link.status());
  ipcMain.handle('perm:get', () => permOk);
  const updater = require('./updater');
  updater.init((st) => { sendWin('update', st); if (st.status === 'available') toast('Update available', 'Version ' + st.latest + ' - open Settings > General', 'ok'); if (st.status === 'ready') toast('Update ready', 'Restart A-tuls to finish', 'ok'); }, (m) => lifecycle.line(m));
  // lyrics (pill) and calendars (home page)
  const lyrics = require('./lyrics'); lyrics.init(app.getPath('userData'), app.getVersion());
  const calendar = require('./calendar');
  calendar.init(protectedStore(store), app.getPath('userData'), () => sendWin('cal', calendar.sources()));
  ipcMain.handle('lyrics:get', (_e, q) => (store.get('lyrics', true) && q && q.title ? lyrics.lookup({ title: String(q.title), artist: String(q.artist || ''), duration: Number(q.duration) || 0 }).catch(() => null) : null));
  ipcMain.handle('cal:range', (_e, from, to) => calendar.range(Number(from) || 0, Number(to) || 0));
  ipcMain.handle('cal:sources', () => calendar.sources());
  ipcMain.handle('cal:add', async (_e, name, url) => { const r = await calendar.add(name, url); lifecycle.line('calendar: add ' + (r.ok ? 'ok' : 'failed - ' + r.error)); return r; });
  ipcMain.handle('cal:remove', (_e, id) => { lifecycle.line('calendar: removed one'); calendar.remove(id); return calendar.sources(); });
  ipcMain.handle('cal:refresh', async () => { await calendar.refresh(); return calendar.sources(); });
  // the picture in the top corner of the home page (the user's own, else the A-tuls logo) and the colour of its decorations
  const profileFile = () => path.join(app.getPath('userData'), 'profile.png');
  const lookState = () => {
    let profile = '';
    try { profile = 'data:image/png;base64,' + fs.readFileSync(profileFile()).toString('base64'); } catch {}
    return { accent: colorOk(store.get('accent', '')) || '#0a84ff', profile, pillPos: store.get('pillPos', 'center'), claudeNotify: store.get('claudeNotify', true) !== false, canClaudeNotify: process.platform === 'win32', waBannerSec: Math.min(60, Math.max(2, Number(store.get('waBannerSec', 5)) || 5)), openMode: store.get('openMode', 'hover') === 'click' ? 'click' : 'hover', navMode: store.get('navMode', 'hover') === 'click' ? 'click' : 'hover' };
  };
  // how the island is shown and how its tab buttons work: 'hover' (the pointer rests on it) or 'click'
  ipcMain.handle('look:set', (_e, key, v) => {
    if (key === 'claudeNotify') { store.set(key, !!v); lifecycle.line('settings: Claude notifications ' + (v ? 'on' : 'off')); claudeApply(); sendWin('look', lookState()); return lookState(); }
    if (key === 'waBannerSec') { store.set(key, Math.min(60, Math.max(2, Number(v) || 6))); lifecycle.line('settings: message banner stays ' + store.get(key) + ' s'); sendWin('look', lookState()); return lookState(); }
    if (key !== 'openMode' && key !== 'navMode') return lookState();
    store.set(key, v === 'click' ? 'click' : 'hover');
    lifecycle.line('settings: ' + (key === 'openMode' ? 'island opens on ' : 'tab buttons work on ') + store.get(key));
    sendWin('look', lookState()); return lookState();
  });
  ipcMain.handle('mediablock:get', () => mediaBlockList());
  ipcMain.handle('mediablock:set', (_e, list) => {
    const clean = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim().toLowerCase().slice(0, 60)).filter(Boolean))].slice(0, 30);
    store.set('mediaBlock', clean); lifecycle.line('settings: media ignored from ' + JSON.stringify(clean));
    mediaStop(); // the Windows helper is started again with the new list
    return clean;
  });
  ipcMain.handle('look:get', lookState);
  ipcMain.handle('look:pos', (_e, v) => { store.set('pillPos', v === 'right' ? 'right' : 'center'); lifecycle.line('settings: pill position ' + store.get('pillPos')); placeWindow(); sendWin('look', lookState()); return lookState(); });
  ipcMain.handle('look:accent', (_e, v) => { store.set('accent', colorOk(v)); lifecycle.line('settings: decoration colour ' + store.get('accent')); sendWin('look', lookState()); return lookState(); });
  ipcMain.handle('profile:choose', async () => {
    const r = await dialog.showOpenDialog({ title: 'Choose your picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return lookState();
    try {
      const img = nativeImage.createFromPath(r.filePaths[0]);
      const { width: w, height: h } = img.getSize();
      if (!w || !h) throw new Error('not a picture');
      const s = Math.min(w, h);
      fs.writeFileSync(profileFile(), img.crop({ x: Math.floor((w - s) / 2), y: Math.floor((h - s) / 2), width: s, height: s }).resize({ width: 160, height: 160, quality: 'best' }).toPNG());
      lifecycle.line('settings: own picture set');
    } catch (e) { lifecycle.line('settings: picture failed - ' + e.message); }
    sendWin('look', lookState());
    return lookState();
  });
  ipcMain.handle('profile:reset', () => { try { fs.unlinkSync(profileFile()); } catch {} lifecycle.line('settings: own picture removed'); sendWin('look', lookState()); return lookState(); });
  // volume mixer (Windows): one helper PowerShell, started when the mixer is first used and ended after 3 idle minutes
  let mixChild = null, mixBuf = '', mixJobs = [], mixIdle = null;
  const mixerStop = () => {
    try { if (mixChild) mixChild.kill(); } catch {}
    mixChild = null; mixBuf = '';
    mixJobs.splice(0).forEach((j) => { clearTimeout(j.timer); j.resolve({ error: 'stopped' }); });
  };
  const mixerStart = () => {
    mixChild = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mixer.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    mixChild.stdout.setEncoding('utf8');
    mixChild.stdout.on('data', (d) => {
      mixBuf += d; let i;
      while ((i = mixBuf.indexOf('\n')) >= 0) {
        const l = mixBuf.slice(0, i).trim(); mixBuf = mixBuf.slice(i + 1);
        if (!l) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (o.ready) continue;
        const j = mixJobs.shift(); if (j) { clearTimeout(j.timer); j.resolve(o); }
      }
    });
    mixChild.stdin.on('error', () => {});
    mixChild.on('close', () => { mixChild = null; mixJobs.splice(0).forEach((j) => { clearTimeout(j.timer); j.resolve({ error: 'stopped' }); }); });
    mixChild.on('error', (e) => { lifecycle.line('mixer helper failed: ' + e.message); mixChild = null; });
  };
  const macVolume = (cmd) => new Promise((resolve) => {
    const { execFile } = require('child_process');
    const num = (s, k) => { const m = new RegExp(k + ':(\\d+)').exec(s); return m ? Math.min(100, Number(m[1])) : 0; };
    const read = () => execFile('/usr/bin/osascript', ['-e', 'get volume settings'], { timeout: 4000 }, (err, out) => resolve(err ? { error: 'no answer' } : { master: num(out, 'output volume'), input: num(out, 'input volume'), alert: num(out, 'alert volume'), apps: [] }));
    const m = /^(master|input|alert) (\d+)/.exec(cmd);
    if (m) execFile('/usr/bin/osascript', ['-e', 'set volume ' + (m[1] === 'master' ? 'output' : m[1] === 'input' ? 'input' : 'alert') + ' volume ' + Math.min(100, Number(m[2]))], { timeout: 4000 }, read); else read();
  });
  const mixerAsk = (cmd) => new Promise((resolve) => {
    if (process.platform === 'darwin') return macVolume(cmd).then(resolve);
    if (process.platform !== 'win32') return resolve({ unsupported: true });
    clearTimeout(mixIdle); mixIdle = setTimeout(mixerStop, 180000); mixIdle.unref();
    if (!mixChild) mixerStart();
    const job = { resolve, timer: setTimeout(() => { const i = mixJobs.indexOf(job); if (i >= 0) mixJobs.splice(i, 1); resolve({ error: 'no answer' }); mixerStop(); }, 20000) };
    mixJobs.push(job);
    try { mixChild.stdin.write(cmd.replace(/[\r\n]/g, ' ') + '\n'); } catch { mixJobs.pop(); clearTimeout(job.timer); resolve({ error: 'failed' }); }
  });
  const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  ipcMain.handle('mixer:list', () => mixerAsk('list'));
  ipcMain.handle('mixer:set', (_e, name, v) => mixerAsk('set ' + pct(v) + ' ' + String(name).slice(0, 80)));
  ipcMain.handle('mixer:mute', (_e, name, m) => mixerAsk('mute ' + (m ? 1 : 0) + ' ' + String(name).slice(0, 80)));
  ipcMain.handle('mixer:mac', (_e, kind, v) => mixerAsk((kind === 'input' || kind === 'alert' ? kind : 'master') + ' ' + pct(v)));
  // Mac: the notification tones are played by macOS itself (afplay) from small sound files made here, so they do not depend on the web page's audio
  ipcMain.handle('sound:play', (_e, kind, vol) => playToneMac(String(kind || 'ok'), Number(vol) || 0));
  ipcMain.handle('mixer:master', (_e, v) => mixerAsk(v === undefined ? 'list' : 'master ' + pct(v)));
  app.on('before-quit', mixerStop);
  ipcMain.handle('update:get', () => updater.state);
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('clip:get', () => clipOn());
  const shotState = () => ({ on: shotOn(), dir: shotDir(), other: store.get('shotOther', true), format: store.get('shotFormat', 'png'), limitMb: store.get('shotLimitMb', 500), mac: MAC, macClip: store.get('macClip', true), sizeMb: Math.round(shotFolderFiles().reduce((n, x) => n + x.size, 0) / (1024 * 1024)) });
  ipcMain.handle('shot:get', shotState);
  ipcMain.handle('shot:set', (_e, o) => {
    if (o && typeof o.other === 'boolean') store.set('shotOther', o.other);
    if (o && (o.format === 'png' || o.format === 'jpg')) store.set('shotFormat', o.format);
    if (o && Number(o.limitMb) >= 1) { store.set('shotLimitMb', Math.min(100000, Math.round(Number(o.limitMb)))); limitSnoozeUntil = 0; setTimeout(checkShotLimit, 500); }
    if (o && typeof o.macClip === 'boolean') store.set('macClip', o.macClip);
    if (o && typeof o.on === 'boolean') {
      if (o.on && !shotDir()) store.set('shotDir', path.join(app.getPath('pictures'), 'A-tuls Screenshots'));
      store.set('shotSave', o.on);
    }
    lifecycle.line('settings: save screenshots ' + JSON.stringify(shotState()));
    macTargetSync();
    syncOutFn([...(o && typeof o.other === 'boolean' ? ['shotOther'] : []), ...(o && (o.format === 'png' || o.format === 'jpg') ? ['shotFormat'] : []), ...(o && Number(o.limitMb) >= 1 ? ['shotLimitMb'] : []), ...(o && typeof o.on === 'boolean' ? ['shotSave'] : [])]);
    return shotState();
  });
  ipcMain.handle('shot:choose', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
    const r = await dialog.showOpenDialog(parent, { title: 'Folder for screenshots', defaultPath: shotDir() || app.getPath('pictures'), properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) { store.set('shotDir', r.filePaths[0]); store.set('shotSave', true); lifecycle.line('settings: screenshot folder ' + r.filePaths[0]); }
    return shotState();
  });
  ipcMain.handle('shot:open', () => { if (shotDir()) { fs.mkdirSync(shotDir(), { recursive: true }); shell.openPath(shotDir()); } });
  ipcMain.handle('clip:set', (_e, v) => { lifecycle.line('settings: share clipboard ' + (v ? 'on' : 'off')); store.set('clipboard', !!v); syncOutFn(['clipboard']); });
  ipcMain.handle('link:connect', async (_e, host, pin, side) => {
    // the other computer may not be on the usual port (a stuck leftover of an earlier run holds it): its announced port, or the one used last time
    const near = global.__discovery && global.__discovery.list().find((n) => n.host === host);
    const known = link.recentList().find((x) => x.host === host);
    const port = (near && near.port) || (known && known.port) || undefined;
    try { await link.connect(host, pin, side, null, port); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('link:send-file', async (_e, p) => { try { await link.sendFile(p); return { ok: true }; } catch (e) { toast('Could not send the file', String(e.message).slice(0, 70), 'err'); return { ok: false, error: e.message }; } });
  ipcMain.handle('link:recent', () => link.recentList());
  ipcMain.handle('link:forget', (_e, id) => link.forgetRecent(id));
  ipcMain.handle('link:disconnect', () => link.disconnect());
  ipcMain.handle('tray:get', () => store.get('tray', []));
  ipcMain.handle('tray:set', (_e, list) => store.set('tray', list));
  ipcMain.handle('open', (_e, p) => shell.openPath(p));
  // startDrag needs a non-empty icon, otherwise the drag silently never starts
  const dragIcon = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 200), { width: 32, height: 32 });
  ipcMain.on('drag-out', (e, p) => {
    try { e.sender.startDrag({ file: p, icon: dragIcon }); } catch (err) { console.error('drag-out:', err.message); }
  });
  const keys = { play: Key.AudioPlay, next: Key.AudioNext, prev: Key.AudioPrev };
  const runMediaKey = (k) => {
    if (MAC) { macMediaCommand(k); return; }
    if (['play', 'next', 'prev'].includes(k) && mediaSend && mediaSend(k)) return; // direct and instant
    keys[k] && keyboard.type(keys[k]).catch(() => {}); // fallback: a media key press
  };
  ipcMain.on('media-key', (_e, k) => {
    lifecycle.line('media key ' + k + (link.followsMaster() ? ' (sent to the master)' : ''));
    if (link.followsMaster()) { link.send({ t: 'mediakey', k }); return; } // the music on this screen is the master's: its player is the one to drive
    runMediaKey(k);
  });
  // master mode: what the master's Home page holds goes to the other computer, whose edits and buttons come back
  ipcMain.on('home:push', (_e, payload) => { if (link.iAmMaster() && payload) link.send({ t: 'home', ...payload }); });
  ipcMain.on('home:todo', (_e, todos) => { if (link.followsMaster() && Array.isArray(todos)) link.send({ t: 'todo', todos: todos.slice(0, 100) }); });
  link.on('home', (m) => sendWin('home', m));
  link.on('todo', (t) => sendWin('todo', t));
  link.on('mediakey', (k) => { if (['play', 'next', 'prev'].includes(k)) { lifecycle.line('media key ' + k + ' (from the other computer)'); runMediaKey(k); } });

  // ---- WhatsApp page: the messages WhatsApp Desktop shows as Windows notifications are listed on the island (and on the linked computer's) ----
  const secure = protectedStore(store);
  const WA_MAX = 200;
  const notifier = new WaNotifier(store.get('waLastId', 0));
  let waOn = !!store.get('waOn', false);
  let waItems = [];
  try { const l = secure.get('waLog', []); if (Array.isArray(l)) waItems = l.filter((e) => e && typeof e.k === 'string').slice(-WA_MAX); } catch {}
  // Group messages are listed only when this person is tagged in them: the name(s) or number(s) the person is tagged with ("@Budi", "@62812...")
  let waNames = (() => { const l = store.get('waNames', []); return Array.isArray(l) ? l.map((x) => String(x).trim().replace(/^@/, '').slice(0, 40)).filter(Boolean).slice(0, 8) : []; })();
  const digitsCore = (s) => String(s).replace(/\D/g, '').replace(/^(62|0)/, ''); // 0812..., 62812... and +62 812... are the same number
  const waTagged = (e) => {
    const t = String(e.text || '').toLowerCase();
    if (!waNames.length || !t.includes('@')) return false;
    const tokens = t.split('@').slice(1).map((s) => s.split(/[\s,;:!?]/)[0]); // what follows each @ up to a space or punctuation
    return waNames.some((n) => {
      const low = n.toLowerCase(), phone = /^[+\d\s-]{6,}$/.test(n) ? digitsCore(n) : '';
      if (phone) return tokens.some((tok) => digitsCore(tok).length >= 6 && digitsCore(tok) === phone);
      return tokens.some((tok) => tok === low) || t.includes('@' + low + ' ') || t.endsWith('@' + low); // a name with spaces in it: look for it as it is
    });
  };
  const waShown = (e) => !e.group || e.tagged || waTagged(e);
  // the login of the linked WhatsApp (see wa-connect.js) lives in one file, sealed with the system's own protection where there is one
  const sealOk = () => { try { return (process.platform === 'win32' || app.isPackaged) && safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const waConn = new WaConnect({
    dir: app.getPath('userData'),
    seal: (str) => { try { if (sealOk()) return Buffer.from('S:' + safeStorage.encryptString(str).toString('base64')); } catch {} return Buffer.from('P:' + str); },
    unseal: (buf) => { const t = buf.toString('utf8'); if (t.startsWith('S:')) return safeStorage.decryptString(Buffer.from(t.slice(2), 'base64')); if (t.startsWith('P:')) return t.slice(2); throw new Error('unknown login file'); },
  });
  let waPeerConn = false; // the other computer is connected to WhatsApp (so it can send an answer for this one)
  const waCanReply = () => waConn.state === 'open' || (waPeerConn && !!link.sock);
  const waState = () => ({ on: waOn, canRead: notifier.available(), items: waItems, names: waNames, conn: waConn.info(), canReply: waCanReply() });
  const waPush = () => sendWin('wa', waState());
  const waSave = () => { try { secure.set('waLog', waItems); } catch {} };
  const waClean = (e) => ({ k: String(e.k).slice(0, 120), chat: String(e.chat || e.title || '').slice(0, 80), title: String(e.title || '').slice(0, 80), from: String(e.from || '').slice(0, 60), text: String(e.text || '').slice(0, 400), at: Number(e.at) || Date.now(), group: !!e.group, tagged: !!e.tagged, mine: !!e.mine, q: e.q && e.q.id ? { id: String(e.q.id).slice(0, 80), participant: String(e.q.participant || '').slice(0, 80) } : undefined });
  // new messages: kept, shown on the page, passed on to the linked computer and (when the person is here) announced under the pill
  const waAdd = (list, { remote = false, silent = false } = {}) => {
    const have = new Set(waItems.map((e) => e.k));
    const fresh = list.filter((e) => e && typeof e.k === 'string' && e.k && !have.has(e.k) && (remote || waShown(e))).map(waClean);
    if (!fresh.length) return;
    waItems = waItems.concat(fresh).sort((a, b) => a.at - b.at).slice(-WA_MAX);
    waSave(); waPush();
    if (!remote && link.sock) link.send({ t: 'wa', items: fresh, silent });
    if (silent || !link.here()) return;
    const last = fresh[fresh.length - 1];
    lifecycle.line('whatsapp: ' + fresh.length + ' new message' + (fresh.length > 1 ? 's' : '') + (remote ? ' (from the other computer)' : ''));
    // with a connection the banner has a field to answer in
    toast(fresh.length > 1 ? `${last.title} (+${fresh.length - 1})` : last.title, last.group && last.from ? `${last.from}: ${last.text}` : last.text, 'ok', { icon: 'chat', secs: Math.min(60, Math.max(2, Number(store.get('waBannerSec', 5)) || 5)), reply: waCanReply() && /@/.test(last.chat) ? { chat: last.chat, q: last.q, preview: last.text.slice(0, 100) } : undefined });
  };
  // with a connection the messages come from it; the notifications are then only read for the names they show (the person's own names for the chats)
  notifier.on('messages', (list, silent) => {
    if (!waOn) return;
    if (waConn.state === 'open') { for (const e of list) waConn.learnTitle(e.chat, e.title, e.group); return; }
    waAdd(list, { silent });
  });
  waConn.on('messages', (list) => { if (waOn) waAdd(list); });
  waConn.on('problem', (m) => lifecycle.line('whatsapp: ' + m));
  waConn.on('state', () => {
    lifecycle.line('whatsapp connection: ' + waConn.state + (waConn.name ? ' as ' + waConn.name : ''));
    if (waOn) notifier.start();
    if (link.sock) link.send({ t: 'wastate', open: waConn.state === 'open' });
    waPush();
  });
  link.on('wastate', (open) => { waPeerConn = !!open; waPush(); });
  link.on('status', (st) => { if (st.connected && waConn.state === 'open') link.send({ t: 'wastate', open: true }); if (!st.connected) { waPeerConn = false; waPush(); } });
  // an answer typed on the other computer, which has no connection of its own: it is sent from here
  link.on('wareply', async (m) => {
    try { await waConn.send(String(m.jid), String(m.text), m.q); link.send({ t: 'wareplied', ok: true, jid: m.jid }); } catch (e) { link.send({ t: 'wareplied', ok: false, error: String(e.message).slice(0, 80) }); }
  });
  link.on('wareplied', (m) => { if (!m.ok) toast('Reply not sent', m.error || 'WhatsApp is not connected', 'err'); });
  notifier.on('seen', (id) => store.set('waLastId', id));
  notifier.on('problem', (m) => lifecycle.line('whatsapp notifications could not be read: ' + m));
  link.on('wa', (items, silent) => { if (waOn) waAdd(items, { remote: true, silent }); });
  if (waOn) notifier.start();
  if (waOn && waConn.hasSession()) waConn.start().catch(() => {}); // linked before: connect again by itself
  ipcMain.handle('wa:get', () => waState());
  ipcMain.handle('wa:connect', async () => {
    if (!waOn) { waOn = true; store.set('waOn', true); }
    lifecycle.line('whatsapp: connecting (QR)');
    waConn.start().catch(() => {});
    waPush(); return waState();
  });
  ipcMain.handle('wa:disconnect', async () => { lifecycle.line('whatsapp: unlinking'); await waConn.logout(); if (waOn) notifier.start(); waPush(); return waState(); });
  ipcMain.handle('wa:cancel', async () => { await waConn.stop(false); waPush(); return waState(); });
  // answer a chat: sent here when this computer is connected, else by the other computer
  ipcMain.handle('wa:reply', async (_e, jid, text, q) => {
    jid = String(jid || ''); text = String(text || '').trim().slice(0, 2000);
    if (!/@/.test(jid) || !text) return { ok: false, error: 'Nothing to send' };
    try {
      if (waConn.state === 'open') {
        await waConn.send(jid, text, q);
        const known = waItems.find((e) => e.chat === jid);
        waAdd([{ k: 'me_' + Date.now(), chat: jid, title: known ? known.title : jid.split('@')[0], from: 'You', text, at: Date.now(), group: jid.endsWith('@g.us'), tagged: true, mine: true }], { silent: true });
        lifecycle.line('whatsapp: reply sent');
        return { ok: true };
      }
      if (waPeerConn && link.sock) { link.send({ t: 'wareply', jid, text, q }); lifecycle.line('whatsapp: reply passed to the other computer'); return { ok: true, via: 'peer' }; }
      return { ok: false, error: 'WhatsApp is not connected' };
    } catch (e) { lifecycle.line('whatsapp: reply failed: ' + e.message); return { ok: false, error: String(e.message).slice(0, 80) }; }
  });
  ipcMain.handle('wa:set', (_e, on) => {
    waOn = !!on; store.set('waOn', waOn);
    if (waOn) { notifier.start(); if (waConn.hasSession() && waConn.state === 'off') waConn.start().catch(() => {}); } else { notifier.stop(); waConn.stop(false); waItems = []; waSave(); } // switching it off also forgets the messages
    lifecycle.line('whatsapp messages ' + (waOn ? 'on' : 'off'));
    waPush(); return waState();
  });
  ipcMain.handle('wa:names', (_e, list) => {
    waNames = (Array.isArray(list) ? list : String(list || '').split(',')).map((x) => String(x).trim().replace(/^@/, '').slice(0, 40)).filter(Boolean).slice(0, 8);
    store.set('waNames', waNames);
    if (notifier.available()) { waItems = waItems.filter(waShown); waSave(); } // here the messages are read: group messages that are not about this person (any more) are removed
    lifecycle.line('whatsapp: ' + waNames.length + ' name(s) for tags');
    waPush(); return waState();
  });
  ipcMain.handle('wa:clear', () => { waItems = []; waSave(); waPush(); return waState(); });
  ipcMain.handle('wa:open', (_e, jid) => {
    const j = String(jid || ''), phone = /@s\.whatsapp\.net$/.test(j) ? j.split('@')[0].split(':')[0] : '';
    shell.openExternal(/^\d{6,}$/.test(phone) ? 'whatsapp://send?phone=' + phone : 'whatsapp://').catch(() => {});
  });

  // ---- Claude desktop: what it tells the person (it needs a permission, a task is done) is shown under the pill as well. They are the notifications
  // the Claude app itself makes on Windows; on the computer the person is not at they are passed on to the one they are at.
  const claudeNotifier = new WaNotifier(store.get('claudeLastId', 0), 'Claude_%!Claude');
  claudeNotifier.on('seen', (id) => store.set('claudeLastId', id));
  claudeNotifier.on('messages', (list, silent) => {
    if (silent || !store.get('claudeNotify', true)) return;
    const e = list[list.length - 1];
    lifecycle.line('claude: ' + list.length + ' notification' + (list.length > 1 ? 's' : '') + (link.here() ? ' shown' : ' passed on'));
    if (link.here()) toast(e.title || 'Claude', e.text || '', 'ok', { icon: 'claude' });
    else if (link.sock) link.send({ t: 'notice', title: String(e.title || 'Claude').slice(0, 60), text: String(e.text || '').slice(0, 140), kind: 'ok' });
  });
  const claudeApply = () => { if (store.get('claudeNotify', true) && claudeNotifier.available()) claudeNotifier.start(); else claudeNotifier.stop(); };
  claudeApply();

  // ---- Usage page: memory of this computer and the AI tokens used today (worked out when the page asks, see usage.js)
  // claude.ai is opened in a window of its own with its own storage: the person signs in there once, and A-tuls asks that storage for the usage numbers
  const claudeSes = () => session.fromPartition('persist:claude-web');
  const claudeFetch = (url) => claudeSes().fetch(url, { headers: { Accept: 'application/json' } });
  let claudeWin = null;
  let loggedKeys = '';
  ipcMain.handle('usage:get', async () => {
    const r = await usage.get(app.getAppMetrics().reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) / 1024, !!store.get('planOn', false), claudeFetch);
    if (r.plan && r.plan.keys && r.plan.keys.join() !== loggedKeys) { loggedKeys = r.plan.keys.join(); lifecycle.line('usage: the limits came with ' + loggedKeys); }
    return r;
  });
  ipcMain.handle('usage:claudeLogin', () => {
    if (claudeWin && !claudeWin.isDestroyed()) { claudeWin.show(); claudeWin.focus(); return; }
    claudeWin = new BrowserWindow({ width: 540, height: 760, title: 'Sign in to Claude', autoHideMenuBar: true, backgroundColor: '#1f1e1d', webPreferences: { partition: 'persist:claude-web', contextIsolation: true, sandbox: true } });
    claudeWin.setMenu(null);
    claudeWin.webContents.setUserAgent(app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ a-tuls\/\S+/i, '')); // a browser like any other (some sign-in pages refuse unknown ones)
    claudeWin.loadURL('https://claude.ai/login');
    claudeWin.on('closed', () => { claudeWin = null; usage.resetPlan(); lifecycle.line('usage: the Claude sign-in window was closed'); });
  });
  ipcMain.handle('usage:claudeOut', async () => { try { await claudeSes().clearStorageData(); } catch {} usage.resetPlan(); lifecycle.line('usage: signed out of claude.ai'); return true; });
  ipcMain.handle('usage:openWeb', () => { shell.openExternal('https://claude.ai/settings/usage').catch(() => {}); });
  ipcMain.handle('usage:plan', (_e, on) => { store.set('planOn', !!on); lifecycle.line('usage: Claude plan limits ' + (on ? 'on' : 'off')); return !!on; });

  // ---- Alarms: a banner under the pill that stays, with a sound that comes back every few seconds, until the person answers it with one of its buttons
  function alarm(id, title, text, icon, actions) { toast(title, text, 'ok', { icon, alarm: { id, actions } }); }
  ipcMain.handle('alarm:act', (_e, id, key) => {
    lifecycle.line('alarm ' + id + ': ' + key);
    if (id === 'water') { if (key === 'drank') water.drink(); else water.snooze(10); waterSave(); }
  });

  // ---- Water page: a reminder every so many minutes (see water.js). When the person drank and when the last reminder came is the same on both
  // computers; the settings are not. The reminder is shown on the computer where the person is.
  const water = new Water(store.get('water', null));
  const waterPush = () => sendWin('water', water.status());
  const waterSave = (share = true) => { store.set('water', water.toJSON()); if (share && link.sock) link.send({ t: 'water', w: water.toJSON() }); waterPush(); };
  ipcMain.handle('water:get', () => water.status());
  ipcMain.handle('water:drink', () => { water.drink(); lifecycle.line('water: drank, next reminder in ' + water.cfg.every + ' min'); waterSave(); return water.status(); });
  ipcMain.handle('water:set', (_e, patch) => { water.set(patch); lifecycle.line('settings: water reminder ' + (water.cfg.on ? 'every ' + water.cfg.every + ' min' : 'off')); waterSave(); return water.status(); });
  ipcMain.handle('water:snooze', (_e, min) => { water.snooze(min); waterSave(); return water.status(); });
  ipcMain.handle('water:test', () => { alarm('water', 'Time to drink water', 'Drink a glass of water', 'water', [{ key: 'drank', label: 'I drank', primary: true }, { key: 'snooze', label: 'Snooze 10 min' }]); });
  link.on('water', (w) => { if (water.adopt(w)) { store.set('water', water.toJSON()); waterPush(); } });
  let waterLinked = false;
  link.on('status', (s) => { if (s.connected && !waterLinked && link.sock) link.send({ t: 'water', w: water.toJSON() }); waterLinked = !!s.connected; }); // the newer copy wins on both sides
  const waterTick = () => {
    try {
      if (!water.due() || !link.here()) return;
      water.ring(); waterSave();
      lifecycle.line('water: reminder ' + water.nag);
      alarm('water', 'Time to drink water', 'Drink a glass of water', 'water', [{ key: 'drank', label: 'I drank', primary: true }, { key: 'snooze', label: 'Snooze 10 min' }]);
    } catch (e) { console.error('[island] water tick failed:', e.message); }
  };
  setInterval(waterTick, 15000).unref();

  createTray();
});

let shuttingDown = false;
// A smoke test of the windows, run from outside with `control.cmd` = selftest: every settings page is opened in a hidden window and
// checked for script errors and content; the island page is checked for errors since start. Results go to the run log.
async function selfTest() {
  const L = (s) => lifecycle.line('selftest: ' + s);
  L('start');
  try {
    const w = new BrowserWindow({ show: false, width: 940, height: 680, webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, sandbox: false } });
    const errors = [];
    w.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(String(msg).slice(0, 160)); });
    w.webContents.on('render-process-gone', (_e, d) => errors.push('renderer gone ' + d.reason));
    await w.loadFile(path.join(__dirname, 'settings.html'));
    await new Promise((r) => setTimeout(r, 2500));
    const pages = await w.webContents.executeJavaScript("Array.from(document.querySelectorAll('aside button')).map((b) => b.dataset.p)");
    for (const p of pages) {
      const info = await w.webContents.executeJavaScript(`(async () => { document.querySelector('aside button[data-p="${p}"]').click(); await new Promise((r) => setTimeout(r, 400)); const m = document.getElementById('main'); return { len: m.innerText.length, title: (m.querySelector('h2') || {}).innerText || '', controls: m.querySelectorAll('input,select,button').length }; })()`);
      L(`settings page ${p}: "${info.title}", ${info.len} characters, ${info.controls} controls`);
    }
    L(errors.length ? 'settings window ERRORS: ' + errors.join(' | ') : 'settings window: no script errors');
    w.destroy();
  } catch (e) { L('settings window FAILED: ' + e.message); }
  try {
    const ids = ['island', 'panel', 'tab-media', 'tab-chat', 'tab-water', 'tab-usage', 'tab-tray', 'tab-link', 'wa-list', 'water-ring', 'gear', 'avatar', 'top-mixer', 'lyr-list', 'todo-list', 'cal-week', 'dots', 'peer-side', 'nearby', 'files', 'send'];
    const missing = await win.webContents.executeJavaScript(`${JSON.stringify(ids)}.filter((i) => !document.getElementById(i))`);
    L(missing.length ? 'island page missing elements: ' + missing.join(', ') : 'island page: all key elements present');
  } catch (e) { L('island page check FAILED: ' + e.message); }
  try { const r = require('./radial'); L('radial menu module loaded; open=' + r.isOpen); } catch (e) { L('radial module FAILED: ' + e.message); }
  L('hooks: ' + (typeof native.removeHooks === 'function' ? 'api present' : 'api missing') + ', pointer link: ' + (link && link.sock ? 'connected' : 'not connected'));
  L('done');
}

// A separate watchdog process ends and restarts the app if its main thread stops answering (see guardian.js).
let guardian = null;
function startGuardian() {
  if (process.env.ISLAND_NO_GUARD) return;
  try {
    const { fork } = require('child_process');
    const g = fork(path.join(__dirname, 'guardian.js'), [String(process.pid), process.execPath, JSON.stringify(process.argv.slice(1)), process.cwd(), lifecycle.file || '', String(process.env.ISLAND_RECOVERED || 0)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      detached: true, // it must outlive the app: it ends a frozen app and starts the next one (without this it is ended together with the app)
    });
    guardian = g;
    const beat = () => { try { if (g.connected) g.send('beat'); } catch {} };
    beat();
    const t = setInterval(beat, 1000);
    g.on('exit', () => { clearInterval(t); if (guardian === g) guardian = null; });
    g.on('error', () => {});
  } catch (e) { lifecycle.line('watchdog could not start: ' + e.message); }
}
function stopGuardian() { try { if (guardian) { guardian.send('stop'); guardian.kill(); } } catch {} guardian = null; }

function shutdownAll(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycle.line('shutting down (' + why + '): closing sockets, camera and hooks');
  gazeQuit = true;
  stopGuardian();
  try { diag && diag.stop(); } catch {}
  try { gazeWin && !gazeWin.isDestroyed() && gazeWin.destroy(); } catch {}
  try { global.__discovery && global.__discovery.stop(); } catch {}
  mrStopped = true; try { mrChild && mrChild.kill(); } catch {}
  try { edgefx.destroy(); } catch {}
  try { mediaStop(); } catch {}
  try { macTargetRestore(); } catch {}
  try { link && link.stop(); } catch {}
  try { native.setCursorHidden(false); native.macMouse.hideCursor(false); } catch {}
  try { native.removeHooks(); } catch {}
  // whatever is still hanging does not get to keep the process alive
  setTimeout(() => { lifecycle.line('shutdown took too long: forcing the exit'); app.exit(0); }, 3000);
}
app.on('before-quit', () => shutdownAll('quit'));
try { require('electron').powerMonitor.on('shutdown', () => shutdownAll('system shutdown')); } catch {}
process.on('exit', () => { try { native.setCursorHidden(false); native.macMouse.hideCursor(false); } catch {} });
app.on('window-all-closed', () => {});
