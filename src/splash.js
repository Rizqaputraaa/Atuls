// Start-up animation: the logo appears in the middle of the top of the screen, shines, and flies up into the pill.
// It runs in its own click-through window and closes by itself; the pill is revealed when the logo arrives.
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const TOTAL = 2600;      // length of the animation (ms)
const PILL_AT = 1750;    // the logo has reached the pill at about this moment (ms)

// returns how many ms the pill should wait before it appears (0 when the animation is off)
const HEX = /^#[0-9a-f]{6}$/i;
function play({ enabled, pillCenterY, colors }) {
  if (!enabled) return 0;
  try {
    const d = screen.getPrimaryDisplay().bounds, W = 460, H = 440;
    const w = new BrowserWindow({
      x: Math.round(d.x + (d.width - W) / 2), y: d.y, width: W, height: H, frame: false, transparent: true, resizable: false, movable: false,
      hasShadow: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
      webPreferences: { contextIsolation: true },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    // shown as soon as the page is ready (either signal; a transparent window does not always send the first one) and every step is logged,
    // so a missing animation can be explained from island-run.log
    const log = (t) => { try { require('./lifecycle').line('splash: ' + t); } catch {} };
    let shown = false;
    const show = (why) => { if (shown || w.isDestroyed()) return; shown = true; w.showInactive(); log('shown (' + why + ')'); };
    w.once('ready-to-show', () => show('ready-to-show'));
    w.webContents.once('did-finish-load', () => show('did-finish-load'));
    w.webContents.on('did-fail-load', (_e, code, desc) => log('page failed to load: ' + code + ' ' + desc));
    w.webContents.on('console-message', (_e, level, message) => { if (level >= 2) log('page says: ' + message); });
    w.webContents.on('render-process-gone', (_e, d) => log('page process gone: ' + d.reason));
    w.loadFile(path.join(__dirname, 'splash.html'), { query: { pill: String(Math.round(pillCenterY)), c1: colors && HEX.test(colors.c1) ? colors.c1.slice(1) : '', c2: colors && HEX.test(colors.c2) ? colors.c2.slice(1) : '' } });
    log('started');
    setTimeout(() => { try { if (!w.isDestroyed()) w.destroy(); } catch {} }, TOTAL + 400);
    return PILL_AT;
  } catch (e) { console.error('[island] start-up animation failed:', e.message); return 0; }
}

module.exports = { play, TOTAL };
