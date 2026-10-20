// A short light effect on the edges of the screen when control moves between computers: a flash along all four edges, a stronger glow
// and rings where the pointer went through. One transparent, click-through window per display, created once and reused.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const MAC = process.platform === 'darwin';
let colorSource = () => ({}); // the colours picked in Settings (shared with the start-up animation)
const setColorSource = (fn) => { colorSource = fn; };
const windows = new Map(); // display id -> { win, ready, hideTimer }

function windowFor(display) {
  let e = windows.get(display.id);
  if (e && !e.win.isDestroyed()) return e;
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, transparent: true, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, enableLargerThanScreen: true, ...(MAC ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(__dirname, 'edgefx-preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  e = { win, ready: new Promise((res) => win.webContents.once('did-finish-load', res)), hideTimer: null };
  win.loadFile(path.join(__dirname, 'edgefx.html'));
  windows.set(display.id, e);
  return e;
}

// the edge of the screen nearest to a point
function nearestEdge(d, p) {
  const b = d.bounds;
  const dist = { left: p.x - b.x, right: b.x + b.width - p.x, top: p.y - b.y, bottom: b.y + b.height - p.y };
  return Object.keys(dist).sort((a, c) => dist[a] - dist[c])[0];
}

async function play({ kind = 'enter', edge } = {}) {
  try {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const e = windowFor(d);
    await e.ready;
    if (e.win.isDestroyed()) return;
    const b = d.bounds;
    e.win.setBounds(b);
    const c = colorSource() || {};
    e.win.webContents.send('fx-play', { colors: { c1: c.c1 || '', c2: c.c2 || '' }, kind, edge: ['left', 'right', 'top', 'bottom'].includes(edge) ? edge : nearestEdge(d, p), x: p.x - b.x, y: p.y - b.y });
    e.win.showInactive();
    clearTimeout(e.hideTimer);
    e.hideTimer = setTimeout(() => { try { if (!e.win.isDestroyed()) e.win.hide(); } catch {} }, 1300);
  } catch (err) { console.error('[island] edge effect failed:', err.message); }
}

// create the windows ahead of time so the first effect has no delay
function warm() { try { for (const d of screen.getAllDisplays()) windowFor(d); } catch {} }

function destroy() { for (const e of windows.values()) { try { e.win.destroy(); } catch {} } windows.clear(); }

module.exports = { play, warm, destroy, setColorSource };
