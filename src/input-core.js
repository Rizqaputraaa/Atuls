const { uIOhook, UiohookKey } = require('uiohook-napi');
const { mouse, Point, Button } = require('@nut-tree-fork/nut-js');
const native = require('./native');

mouse.config.autoDelayMs = 0;

const BUTTONS = { 1: Button.LEFT, 2: Button.RIGHT, 3: Button.MIDDLE };

function start(handlers) {
  uIOhook.on('mousemove', (e) => handlers.move(e.x, e.y));
  uIOhook.on('mousedown', (e) => handlers.down(e.button, e.clicks));
  uIOhook.on('mouseup', (e) => handlers.up(e.button));
  uIOhook.on('wheel', (e) => handlers.wheel(e.direction, e.rotation));
  const NAMES = Object.fromEntries(Object.entries(UiohookKey).map(([k, v]) => [v, k]));
  uIOhook.on('keydown', (e) => NAMES[e.keycode] && handlers.key(NAMES[e.keycode], true));
  uIOhook.on('keyup', (e) => NAMES[e.keycode] && handlers.key(NAMES[e.keycode], false));
  uIOhook.start();
}

const stop = () => uIOhook.stop();
// macOS only, and only while the mouse is untouched (stopping the hook while events flow can deadlock the process)
const restartHook = (tries = 0) => {
  if (process.platform !== 'darwin') return;
  if (tries < 40 && native.macMouse.recentPhysical() !== false) return void setTimeout(() => restartHook(tries + 1), 300);
  try { uIOhook.stop(); } catch {}
  setTimeout(() => { try { uIOhook.start(); } catch (e) { console.error('[island] hook restart failed:', e.message); } }, 150);
};
// On macOS the mouse is injected with CoreGraphics so double clicks (click state) and drags work.
const useCG = () => process.platform === 'darwin' && native.macMouse.available();
let heldBtn = 0, clickState = 1, lastPos = { x: 0, y: 0 };
const setPos = (x, y) => {
  x = Math.round(x); y = Math.round(y);
  lastPos = { x, y };
  if (process.platform === 'win32' && native.winCursor.available() && native.winCursor.set(x, y)) return;
  if (useCG() && native.macMouse.move(x, y, heldBtn)) return;
  return mouse.setPosition(new Point(x, y)).catch(() => {});
};
// macOS only counts a double click when the click state is set, which plain press/release can't do,
// so the second press of a double click is injected as a real double click instead
let skipUp = false;
const press = (b, n = 1) => {
  if (BUTTONS[b] === undefined) return;
  if (useCG()) {
    heldBtn = b; clickState = Math.max(1, n);
    if (n >= 2) console.log('[island] double click injected');
    return native.macMouse.down(b, lastPos.x, lastPos.y, clickState);
  }
  if (process.platform === 'darwin' && n >= 2 && b === 1) { skipUp = true; return mouse.doubleClick(Button.LEFT).catch(() => {}); }
  return mouse.pressButton(BUTTONS[b]).catch(() => {});
};
const release = (b) => {
  if (BUTTONS[b] === undefined) return;
  if (useCG()) { heldBtn = 0; return native.macMouse.up(b, lastPos.x, lastPos.y, clickState); }
  if (skipUp) { skipUp = false; return; }
  return mouse.releaseButton(BUTTONS[b]).catch(() => {});
};
// Scrolling arrives in pixels (positive = down / right). `speed` is the user's slider (1 = 100%).
const scrollRest = { x: 0, y: 0 };
let scrollLog = 0;
function scroll(px, py, speed = 1, reverse = false, local = false, tuned = false) {
  if (scrollLog++ < 5) console.log('[island] scroll injected', Math.round(px), Math.round(py), 'speed', speed);
  const k = (reverse ? -1 : 1) * speed;
  if (process.platform === 'win32') {
    // 120 wheel units are one notch, about 100 px of scrolling in a browser; Windows is wheel-up positive
    scrollRest.y += -py * k * 1.2; scrollRest.x += px * k * 1.2;
    const v = Math.trunc(scrollRest.y), h = Math.trunc(scrollRest.x);
    scrollRest.y -= v; scrollRest.x -= h;
    if (v || h) native.winCursor.wheel(v, h);
    return;
  }
  if (process.platform === 'darwin' && native.macMouse.available()) {
    // pixel units; macOS is wheel-up and wheel-left positive. A notch from a PC wheel is gentler here.
    const f = local || tuned ? 1 : 0.6; // a PC notch is gentler on a Mac; real local scrolling keeps its size
    scrollRest.y += -py * k * f; scrollRest.x += -px * k * f;
    const v = Math.trunc(scrollRest.y), h = Math.trunc(scrollRest.x);
    scrollRest.y -= v; scrollRest.x -= h;
    if (v || h) native.macMouse.scroll(v, h, local);
    return;
  }
  if (py) mouse[py > 0 ? 'scrollDown' : 'scrollUp'](Math.max(1, Math.round(Math.abs(py) * k / 33))).catch(() => {});
}
const freelook = () => (process.platform === 'win32' ? native.winCursor.freelook() : process.platform === 'darwin' && useCG() ? native.macMouse.cursorVisible() === false : false);
const physicalMouse = () => (process.platform === 'darwin' && useCG() ? native.macMouse.recentPhysical() : null);
const getPos = () => (process.platform === 'win32' ? native.winCursor.get() : useCG() ? native.macMouse.pos() : null);

// Keys are captured and injected with uiohook itself, so both ends share one key-code space.
const MODS = ['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'];

const SWAP = {}; // Command on the Mac is the Windows key on the PC; every other key is the same

const heldMods = new Set(), heldKeys = new Set();
let keyLog = 0;
function key(name, down, fromPlatform) {
  const n = (SWAP[`${fromPlatform}>${process.platform}`] || {})[name] || name;
  const code = UiohookKey[n];
  if (code === undefined) return;
  if (keyLog++ < 8) console.log('[island] inject key', n, down ? 'down' : 'up');
  try {
    if (MODS.includes(n)) {
      down ? heldMods.add(n) : heldMods.delete(n);
      return uIOhook.keyToggle(code, down ? 'down' : 'up');
    }
    // macOS ignores synthetic modifier state on later keys, so send held modifiers with each key
    if (process.platform === 'darwin' && heldMods.size) {
      if (down) uIOhook.keyTap(code, [...heldMods].map((m) => UiohookKey[m]));
      return;
    }
    down ? heldKeys.add(code) : heldKeys.delete(code);
    uIOhook.keyToggle(code, down ? 'down' : 'up');
  } catch (e) { console.error('[island] key inject failed:', e.message); }
}
// never leave a key or modifier stuck down on this machine
function releaseAll() {
  if (heldBtn && useCG()) { native.macMouse.up(heldBtn, lastPos.x, lastPos.y, clickState); heldBtn = 0; }
  try {
    for (const c of heldKeys) uIOhook.keyToggle(c, 'up');
    for (const m of heldMods) uIOhook.keyToggle(UiohookKey[m], 'up');
  } catch {}
  heldKeys.clear(); heldMods.clear();
}
// Region screenshot straight to the clipboard on macOS (Cmd+Ctrl+Shift+4); the clipboard sync brings it back
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function screenshot() {
  releaseAll();
  try {
    if (process.platform === 'darwin') uIOhook.keyTap(UiohookKey['4'], [UiohookKey.Meta, UiohookKey.Ctrl, UiohookKey.Shift]);
    else {
      // Windows snipping (Win+Shift+S). A key tap with no pause between the keys makes the overlay close again at once on current Windows builds,
      // so the keys are pressed and let go one after the other, like a hand does it.
      const K = UiohookKey;
      uIOhook.keyToggle(K.Meta, 'down'); await pause(60);
      uIOhook.keyToggle(K.Shift, 'down'); await pause(60);
      uIOhook.keyToggle(K.S, 'down'); await pause(120);
      uIOhook.keyToggle(K.S, 'up'); await pause(150);
      uIOhook.keyToggle(K.Shift, 'up'); await pause(40);
      uIOhook.keyToggle(K.Meta, 'up');
    }
  } catch (e) { console.error('[island] screenshot key failed:', e.message); }
}
// after a capture on Windows the blocked key-ups never reached the OS, so let go of the common modifiers
function releaseLocalModifiers() {
  try { for (const m of ['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight']) uIOhook.keyToggle(UiohookKey[m], 'up'); } catch {}
}
const click = () => mouse.click(Button.LEFT).catch(() => {});

module.exports = { restartHook, freelook, physicalMouse, getPos, start, stop, setPos, press, release, scroll, key, releaseAll, click, screenshot, releaseLocalModifiers };
