// Small native helpers through koffi. Everything here is optional: if koffi or a
// system call is unavailable the callers fall back to the nut-js / uiohook behaviour.
let koffi = null;
try { koffi = require('koffi'); } catch (e) { console.error('[island] koffi unavailable:', e.message); }

// ---- Windows: low-level hooks that can swallow input ----------------------
// Installed BEFORE uiohook starts so uiohook (installed later, called first) still sees every event.
let winApi = null;
function loadWin() {
  if (winApi !== null) return winApi;
  winApi = false;
  if (process.platform !== 'win32' || !koffi) return winApi;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const HookProc = koffi.proto('intptr_t __stdcall HookProc(int nCode, uintptr_t wParam, void *lParam)');
    winApi = {
      KBD: koffi.struct('KBDLLHOOKSTRUCT', { vkCode: 'uint32_t', scanCode: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' }),
      MSLL: koffi.struct('MSLLHOOKSTRUCT', { x: 'int32_t', y: 'int32_t', mouseData: 'uint32_t', flags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' }),
      HookProc,
      SetHook: user32.func('void *__stdcall SetWindowsHookExW(int idHook, HookProc *lpfn, void *hMod, uint32_t dwThreadId)'),
      CallNext: user32.func('intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, void *lParam)'),
      GetModule: kernel32.func('void *__stdcall GetModuleHandleW(str16 name)'),
      user32,
    };
  } catch (e) {
    console.error('[island] windows hooks unavailable:', e.message);
  }
  return winApi;
}

const hooks = {}; // keep handles and callbacks alive
function installHook(id, struct, decide) {
  const api = loadWin();
  if (!api || hooks[id]) return false;
  try {
    hooks[id] = { handle: null, callback: null };
    hooks[id].callback = koffi.register((nCode, wParam, lParam) => {
      try {
        if (nCode >= 0 && decide(Number(wParam), koffi.decode(lParam, api[struct]))) return 1;
      } catch {}
      return Number(api.CallNext(hooks[id].handle, nCode, wParam, lParam));
    }, koffi.pointer(api.HookProc));
    hooks[id].handle = api.SetHook(id, hooks[id].callback, api.GetModule(null), 0);
    return !!hooks[id].handle;
  } catch (e) {
    console.error('[island] hook', id, 'failed:', e.message);
    return false;
  }
}

// ---- physical screen sizes (millimetres) ----------------------------------------------------------
// macOS: the system knows each display's size.
// The koffi types and functions are made once: declaring a struct a second time (every display change calls this again) throws
// "Duplicate type name" and the screens lost their millimetre sizes, which threw the pointer off target.
let macSizeFns = null;
function macDisplaySizes() {
  if (process.platform !== 'darwin' || !koffi) return [];
  try {
    if (!macSizeFns) {
      const app = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
      koffi.struct('CGSize_ISL', { width: 'double', height: 'double' });
      koffi.struct('CGPoint_ISL', { x: 'double', y: 'double' });
      koffi.struct('CGRect_ISL', { origin: 'CGPoint_ISL', size: 'CGSize_ISL' });
      macSizeFns = {
        list: app.func('int CGGetActiveDisplayList(uint32_t max, _Out_ uint32_t *ids, _Out_ uint32_t *count)'),
        bounds: app.func('CGRect_ISL CGDisplayBounds(uint32_t id)'),
        size: app.func('CGSize_ISL CGDisplayScreenSize(uint32_t id)'),
      };
    }
    const ids = new Uint32Array(16), count = new Uint32Array(1);
    macSizeFns.list(16, ids, count);
    const out = [];
    for (let i = 0; i < count[0]; i++) {
      const b = macSizeFns.bounds(ids[i]), s = macSizeFns.size(ids[i]);
      out.push({ x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height, mmw: s.width, mmh: s.height });
    }
    return out;
  } catch (e) { console.error('[island] display sizes unavailable:', e.message); return []; }
}

// Windows: the monitor reports its panel size in whole centimetres through WMI (EDID). Asking takes a PowerShell run (about half a second, and
// up to several when the computer is busy waking up), so it never happens on the app's main thread: the answer is read in the background
// and kept; callers use the last answer at once and are told when a new one arrives.
let winSizesCache = [], winSizesBusy = false, winSizesAt = 0;
function winMonitorSizes() { return winSizesCache; }
function refreshWinMonitorSizes(done) {
  if (process.platform !== 'win32' || winSizesBusy || Date.now() - winSizesAt < 4000) return; // not again within a burst of display notifications
  winSizesBusy = true; winSizesAt = Date.now();
  try {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | ForEach-Object { '{0},{1}' -f $_.MaxHorizontalImageSize, $_.MaxVerticalImageSize }"], { timeout: 8000, windowsHide: true }, (err, out) => {
      winSizesBusy = false;
      if (err) { console.error('[island] monitor sizes unavailable:', err.message); return; }
      const sizes = String(out).split(/\r?\n/).map((l) => l.trim().split(',').map(Number)).filter((x) => x.length === 2 && x[0] > 0 && x[1] > 0).map(([cmw, cmh]) => ({ mmw: cmw * 10, mmh: cmh * 10 }));
      if (JSON.stringify(sizes) !== JSON.stringify(winSizesCache)) { winSizesCache = sizes; if (done) done(); }
    });
  } catch (e) { winSizesBusy = false; console.error('[island] monitor sizes unavailable:', e.message); }
}

// Windows lists no position for those sizes, so pair each screen with the reported size of the same shape.
function matchSizes(displays, sizes) {
  const free = sizes.slice();
  return displays.map((d) => {
    const shape = Math.min(d.w, d.h) / Math.max(d.w, d.h);
    let best = -1, bestDiff = 0.12;
    free.forEach((s, i) => { const diff = Math.abs(Math.min(s.mmw, s.mmh) / Math.max(s.mmw, s.mmh) - shape); if (diff < bestDiff) { bestDiff = diff; best = i; } });
    if (best < 0) return null;
    const s = free.splice(best, 1)[0];
    const landscapeScreen = d.w >= d.h, landscapePanel = s.mmw >= s.mmh; // a rotated monitor reports its native shape
    return landscapeScreen === landscapePanel ? { mmw: s.mmw, mmh: s.mmh } : { mmw: s.mmh, mmh: s.mmw };
  });
}

// Windows silently removes a low-level hook whose callback ever takes too long (or after sleep / lock).
// These let the app notice that (system input keeps coming, our hooks hear nothing) and put the hooks back.
let hookFns = null;
function reinstallHooks() {
  const api = loadWin();
  if (!api) return 0;
  if (!hookFns) hookFns = { unhook: api.user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)') };
  let n = 0;
  for (const [id, h] of Object.entries(hooks)) {
    try {
      if (h.handle) hookFns.unhook(h.handle);
      h.handle = api.SetHook(Number(id), h.callback, api.GetModule(null), 0);
      if (h.handle) n++;
    } catch (e) { console.error('[island] reinstall hook', id, 'failed:', e.message); }
  }
  return n;
}
function removeHooks() {
  const api = loadWin();
  if (!api) return;
  if (!hookFns) hookFns = { unhook: api.user32.func('bool __stdcall UnhookWindowsHookEx(void *hhk)') };
  for (const h of Object.values(hooks)) { try { if (h.handle) hookFns.unhook(h.handle); } catch {} h.handle = null; }
}
let idleFns = null;
// milliseconds since the user last touched the mouse or keyboard (system wide), or null
function winIdleMs() {
  const api = loadWin();
  if (!api) return null;
  try {
    if (!idleFns) {
      koffi.struct('LASTINPUT_ISL', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
      idleFns = {
        last: api.user32.func('bool __stdcall GetLastInputInfo(_Inout_ LASTINPUT_ISL *p)'),
        tick: koffi.load('kernel32.dll').func('uint32_t __stdcall GetTickCount()'),
      };
    }
    const li = { cbSize: 8, dwTime: 0 };
    if (!idleFns.last(li)) return null;
    return (idleFns.tick() - li.dwTime) >>> 0;
  } catch { return null; }
}

let asyncKey = null;
// true while Ctrl, Alt, Shift or a Windows key is physically down (asked from the system, so it is always right)
function winModsHeld() {
  const api = loadWin();
  if (!api) return false;
  try {
    if (!asyncKey) asyncKey = api.user32.func('int16_t __stdcall GetAsyncKeyState(int vk)');
    return [0x11, 0x12, 0x10, 0x5B, 0x5C].some((vk) => (asyncKey(vk) & 0x8000) !== 0);
  } catch { return false; }
}

// shouldBlock(kbdStruct) -> true swallows the keystroke
const installKeyBlocker = (shouldBlock) => installHook(13 /* WH_KEYBOARD_LL */, 'KBD', (_msg, k) => shouldBlock(k));
// decide(message, { x, y, mouseData, flags }) -> true swallows the mouse event (flags & 1 = injected)
const installMouseHook = (decide) => installHook(14 /* WH_MOUSE_LL */, 'MSLL', decide);

// ---- macOS: mouse events with proper click state (double click) and drags ----
let cg = null;
function loadCG() {
  if (cg !== null) return cg;
  cg = false;
  if (process.platform !== 'darwin' || !koffi) return cg;
  try {
    const app = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    koffi.struct('CGPoint', { x: 'double', y: 'double' });
    cg = {
      create: app.func('void *CGEventCreateMouseEvent(void *source, uint32_t type, CGPoint pos, uint32_t button)'),
      setInt: app.func('void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)'),
      post: app.func('void CGEventPost(uint32_t tap, void *event)'),
      warp: app.func('int CGWarpMouseCursorPosition(CGPoint pos)'),
      suppress: app.func('void CGSetLocalEventsSuppressionInterval(double seconds)'),
      release: cf.func('void CFRelease(void *cf)'),
      hidIdle: app.func('double CGEventSourceSecondsSinceLastEventType(int32_t state, uint32_t type)'),
      hide: app.func('int CGDisplayHideCursor(uint32_t display)'),
      show: app.func('int CGDisplayShowCursor(uint32_t display)'),
      visible: app.func('bool CGCursorIsVisible()'),
      connection: app.func('int CGSMainConnectionID()'),
      setProp: app.func('int CGSSetConnectionProperty(int cid, int targetCid, void *key, void *value)'),
      cfString: cf.func('void *CFStringCreateWithCString(void *alloc, const char *s, uint32_t encoding)'),
      cfTrue: koffi.decode(cf.symbol('kCFBooleanTrue', 'void *'), 'void *'),
      createEmpty: app.func('void *CGEventCreate(void *source)'),
      location: app.func('CGPoint CGEventGetLocation(void *event)'),
      scroll: app.func('void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2, int32_t wheel3)'),
    };
  } catch (e) {
    console.error('[island] CoreGraphics unavailable:', e.message);
    cg = false;
  }
  return cg;
}

// uiohook button (1 left, 2 right, 3 middle) -> CG button number and event types
const CG_BUTTON = { 1: { n: 0, down: 1, up: 2, drag: 6 }, 2: { n: 1, down: 3, up: 4, drag: 7 }, 3: { n: 2, down: 25, up: 26, drag: 27 } };

let lastPost = 0, suppressed = false;
function macPost(type, x, y, button, clickState) {
  try { return macPostUnsafe(type, x, y, button, clickState); } catch (e) { console.error('[island] CG post failed:', e.message); return false; }
}

function macPostUnsafe(type, x, y, button, clickState) {
  const api = loadCG();
  if (!api) return false;
  if (type === 5 || type === 6 || type === 7 || type === 27) {
    if (!suppressed) { api.suppress(0); suppressed = true; }
    api.warp({ x, y });
  }
  const moving = type === 5 || type === 6 || type === 7 || type === 27;
  // plain moves: warp every time, but post the (costly) event at most every ~10 ms
  if (moving && type === 5 && Date.now() - lastPost < 10) return true;
  lastPost = Date.now();
  const ev = api.create(null, type, { x, y }, button);
  if (!ev) return false;
  if (clickState) api.setInt(ev, 1 /* kCGMouseEventClickState */, clickState);
  // the session tap honours the event's location; the HID tap would only apply (zero) deltas
  api.post(1 /* kCGSessionEventTap */, ev);
  api.release(ev);
  return true;
}

// Windows timers tick every 15.6 ms by default (64 Hz), which makes cursor movement look choppy.
// Asking for 1 ms makes our 4-6 ms timers actually fire that often.
function highResTimer() {
  if (process.platform !== 'win32' || !koffi) return false;
  try {
    return koffi.load('winmm.dll').func('uint32_t __stdcall timeBeginPeriod(uint32_t ms)')(1) === 0;
  } catch (e) { console.error('[island] timer resolution unchanged:', e.message); return false; }
}

// ---- Windows: hide the system cursor while this computer controls another one ----
const SYSTEM_CURSORS = [32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650];
let cursorFns = null;
function setCursorHidden(hide) {
  const api = loadWin();
  if (!api) return false;
  try {
    if (!cursorFns) {
      cursorFns = {
        create: api.user32.func('void *__stdcall CreateCursor(void *hInst, int xHot, int yHot, int w, int h, const void *andPlane, const void *xorPlane)'),
        set: api.user32.func('bool __stdcall SetSystemCursor(void *hcur, uint32_t id)'),
        spi: api.user32.func('bool __stdcall SystemParametersInfoW(uint32_t action, uint32_t param, void *pv, uint32_t ini)'),
      };
    }
    if (!hide) return cursorFns.spi(0x57 /* SPI_SETCURSORS: reload the user's own cursors */, 0, null, 0);
    const and = Buffer.alloc(128, 0xff), xor = Buffer.alloc(128, 0);
    for (const id of SYSTEM_CURSORS) cursorFns.set(cursorFns.create(null, 0, 0, 32, 32, and, xor), id);
    return true;
  } catch (e) {
    console.error('[island] cursor hide failed:', e.message);
    return false;
  }
}

// ---- Windows: read/set the cursor synchronously and inject wheel movement ----
let winIn = null;
function loadWinInput() {
  if (winIn !== null) return winIn;
  winIn = false;
  const api = loadWin();
  if (!api) return winIn;
  try {
    const POINT = koffi.struct('POINT_ISL', { x: 'int32_t', y: 'int32_t' });
    const INPUT = koffi.struct('INPUT_ISL', { type: 'uint32_t', pad: 'uint32_t', dx: 'int32_t', dy: 'int32_t', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', pad2: 'uint32_t', dwExtraInfo: 'uintptr_t' });
    winIn = {
      get: api.user32.func('bool __stdcall GetCursorPos(_Out_ POINT_ISL *p)'),
      set: api.user32.func('bool __stdcall SetCursorPos(int x, int y)'),
      send: api.user32.func('uint32_t __stdcall SendInput(uint32_t n, INPUT_ISL *inputs, int size)'),
    };
  } catch (e) {
    console.error('[island] windows input unavailable:', e.message);
  }
  return winIn;
}
// Is something else in charge of the pointer (a game that hides it or confines it to its window)?
let freelookFns = null;
function winFreelook() {
  const w = loadWinInput();
  if (!w) return false;
  try {
    if (!freelookFns) {
      koffi.struct('CURSORINFO_ISL', { cbSize: 'uint32_t', flags: 'uint32_t', hCursor: 'void *', x: 'int32_t', y: 'int32_t' });
      koffi.struct('RECT_ISL', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
      const api = loadWin();
      koffi.struct('MONITORINFO_ISL', { cbSize: 'uint32_t', rcMonitor: 'RECT_ISL', rcWork: 'RECT_ISL', dwFlags: 'uint32_t' });
      freelookFns = {
        info: api.user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO_ISL *pci)'),
        clip: api.user32.func('bool __stdcall GetClipCursor(_Out_ RECT_ISL *r)'),
        metric: api.user32.func('int __stdcall GetSystemMetrics(int i)'),
        fg: api.user32.func('void * __stdcall GetForegroundWindow()'),
        wrect: api.user32.func('bool __stdcall GetWindowRect(void *h, _Out_ RECT_ISL *r)'),
        monitor: api.user32.func('void * __stdcall MonitorFromWindow(void *h, uint32_t flags)'),
        minfo: api.user32.func('bool __stdcall GetMonitorInfoW(void *m, _Inout_ MONITORINFO_ISL *mi)'),
      };
    }
    // Apps hide the pointer for ordinary reasons too (painting in Photoshop, typing in some editors), so a hidden pointer only counts when
    // the foreground window also covers a whole monitor, as a full-screen game does. A pointer confined to a smaller area is a stronger sign.
    const ci = { cbSize: 24, flags: 0, hCursor: null, x: 0, y: 0 };
    if (freelookFns.info(ci) && !(ci.flags & 1) && fullscreenForeground()) return 'hidden-fullscreen';
    const r = {};
    if (freelookFns.clip(r)) {
      const vx = freelookFns.metric(76), vy = freelookFns.metric(77), vw = freelookFns.metric(78), vh = freelookFns.metric(79);
      const slack = 4; // rounding at the screen edges is not confinement
      if (r.left > vx + slack || r.top > vy + slack || r.right < vx + vw - slack || r.bottom < vy + vh - slack) return 'confined';
    }
  } catch { /* unknown: assume not */ }
  return '';
}
function fullscreenForeground() {
  const h = freelookFns.fg();
  if (!h) return false;
  const w = {};
  if (!freelookFns.wrect(h, w)) return false;
  const mi = { cbSize: 40, rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  const m = freelookFns.monitor(h, 2); // nearest monitor
  if (!m || !freelookFns.minfo(m, mi)) return false;
  const b = mi.rcMonitor;
  return w.left <= b.left && w.top <= b.top && w.right >= b.right && w.bottom >= b.bottom;
}

// Windows lets a program send input only to windows at its own level of rights or lower. An app running as administrator (Task Manager, some
// installers) therefore ignores everything A-tuls injects. true = the window in front runs with more rights than this app (or cannot be
// inspected because of that), false = it does not, null = unknown.
let elevFns = null;
function winForegroundElevated() {
  const api = loadWin();
  if (!api) return null;
  try {
    if (!elevFns) {
      const k = koffi.load('kernel32.dll'), a = koffi.load('advapi32.dll');
      elevFns = {
        fg: api.user32.func('void * __stdcall GetForegroundWindow()'),
        tid: api.user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)'),
        open: k.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
        close: k.func('bool __stdcall CloseHandle(void *h)'),
        token: a.func('bool __stdcall OpenProcessToken(void *h, uint32_t access, _Out_ void **tok)'),
        info: a.func('bool __stdcall GetTokenInformation(void *tok, int cls, _Out_ uint32_t *out, uint32_t len, _Out_ uint32_t *ret)'),
      };
    }
    const h = elevFns.fg();
    if (!h) return null;
    const pid = new Uint32Array(1);
    elevFns.tid(h, pid);
    const hp = elevFns.open(0x1000, false, pid[0]); // PROCESS_QUERY_LIMITED_INFORMATION
    if (!hp) return koffi.errno() === 5 ? true : null; // access denied: it runs with more rights than we do
    let result = null;
    const tok = [null];
    if (elevFns.token(hp, 8, tok) && tok[0]) {
      const out = new Uint32Array(1), ret = new Uint32Array(1);
      if (elevFns.info(tok[0], 20, out, 4, ret)) result = out[0] !== 0; // TokenElevation
      elevFns.close(tok[0]);
    }
    elevFns.close(hp);
    return result;
  } catch { return null; }
}

const winCursor = {
  available: () => !!loadWinInput(),
  freelook: winFreelook,
  foregroundElevated: winForegroundElevated,
  get: () => { const w = loadWinInput(); if (!w) return null; const p = {}; return w.get(p) ? { x: p.x, y: p.y } : null; },
  set: (x, y) => { const w = loadWinInput(); return w ? w.set(x, y) : false; },
  // side buttons (which: 1 = back, 2 = forward)
  xbutton: (which, isDown) => {
    const w = loadWinInput();
    if (!w) return false;
    w.send(1, [{ type: 0, pad: 0, dx: 0, dy: 0, mouseData: which, dwFlags: isDown ? 0x0080 : 0x0100, time: 0, pad2: 0, dwExtraInfo: 0 }], 40);
    return true;
  },
  // wheel units: 120 = one notch, smaller values are fine for smooth scrolling
  wheel: (vertical, horizontal) => {
    const w = loadWinInput();
    if (!w) return false;
    const mk = (flags, v) => ({ type: 0, pad: 0, dx: 0, dy: 0, mouseData: v >>> 0, dwFlags: flags, time: 0, pad2: 0, dwExtraInfo: 0 });
    if (vertical) w.send(1, [mk(0x0800, vertical)], 40);
    if (horizontal) w.send(1, [mk(0x1000, horizontal)], 40);
    return true;
  },
};

let cursorHiddenByUs = false;
// ---- macOS: event tap for scrolling ---------------------------------------------------------------
// The global hook only reports whole "lines" (slow trackpad scrolling rounds to 0), so scrolling is read here with
// exact pixel deltas, and it can be swallowed while the other computer is being controlled.
let scrollTap = null;
// ideas from the open-source Mos scroller: a smoothed wheel is re-posted as a copy of the real event (same position and
// target), straight to the application under the pointer, so it never travels through the tap again
let scrollTemplate = null, scrollPost = null;
// Multiply the distance of a real wheel event in place (point, fixed-point and line deltas), so the system keeps its own smooth
// delivery. A negative factor reverses the direction. A wheel that moved at all always moves at least one unit.
function scaleWheel(event, f) {
  const sign = f < 0 ? -1 : 1, k = Math.abs(f);
  const scaleI = (field) => { const v = Number(scrollPost.getI(event, field)); if (!v) return; let o = Math.round(v * k * sign); if (!o) o = (v * sign) > 0 ? 1 : -1; scrollPost.setI(event, field, o); };
  const scaleD = (field) => { const v = scrollPost.getD(event, field); if (v) scrollPost.setD(event, field, v * k * sign); };
  scaleI(96); scaleI(97); // point deltas (pixels)
  scaleD(93); scaleD(94); // fixed-point deltas
  scaleI(11); scaleI(12); // line deltas
}
function installScrollTap(onScroll) {
  if (scrollTap || process.platform !== 'darwin' || !koffi) return false;
  try {
    const app = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    const TapCb = koffi.proto('void *ScrollTapCb(void *proxy, uint32_t type, void *event, void *info)');
    const create = app.func('void *CGEventTapCreate(uint32_t tap, uint32_t place, uint32_t options, uint64_t mask, ScrollTapCb *cb, void *info)');
    const enable = app.func('void CGEventTapEnable(void *tap, bool on)');
    const getInt = app.func('int64_t CGEventGetIntegerValueField(void *event, uint32_t field)');
    const getFlags = app.func('uint64_t CGEventGetFlags(void *event)');
    scrollPost = {
      copy: app.func('void *CGEventCreateCopy(void *event)'),
      toPid: app.func('void CGEventPostToPid(int32_t pid, void *event)'),
      setD: app.func('void CGEventSetDoubleValueField(void *event, uint32_t field, double value)'),
      setI: app.func('void CGEventSetIntegerValueField(void *event, uint32_t field, int64_t value)'),
      release: cf.func('void CFRelease(void *cf)'),
      getI: getInt,
      getD: app.func('double CGEventGetDoubleValueField(void *event, uint32_t field)'),
    };
    const makeSource = cf.func('void *CFMachPortCreateRunLoopSource(void *alloc, void *port, int64_t order)');
    const mainLoop = cf.func('void *CFRunLoopGetMain()');
    const addSource = cf.func('void CFRunLoopAddSource(void *rl, void *source, void *mode)');
    const commonModes = koffi.decode(cf.symbol('kCFRunLoopCommonModes', 'void *'), 'void *');
    let port = null;
    const cb = koffi.register((_proxy, type, event, _info) => {
      try {
        if (type === 0xfffffffe || type === 0xffffffff) { enable(port, true); try { onScroll(0, 0, { disabled: type }); } catch {} return event; } // the system switched the tap off: switch it back on
        if (type >= 1 && type <= 4) { // left / right button down and up: only matters while the color picker is live
          if (onScroll(0, 0, { click: ['', 'ldown', 'lup', 'rdown', 'rup'][type] })) return null;
          return event;
        }
        if (type === 25 || type === 26) { // other mouse buttons: the wheel press is button 2
          if (Number(getInt(event, 3)) === 2 && onScroll(0, 0, { mid: type === 25 ? 1 : 2 })) return null;
          return event;
        }
        if (type === 22) { // kCGEventScrollWheel; point deltas are in pixels, positive = up / left
          const dy = Number(getInt(event, 96)), dx = Number(getInt(event, 97));
          // field 88 = continuous (trackpad / smooth devices), 42 = user data we put on the events we post ourselves
          const info = { continuous: Number(getInt(event, 88)) !== 0, ours: Number(getInt(event, 42)) === 0x1517, lx: -Number(getInt(event, 12)), ly: -Number(getInt(event, 11)), flags: Number(getFlags(event)) };
          if (!info.ours && !info.continuous && scrollPost) { // remember the latest real wheel event as the template for smoothed ones
            const c = scrollPost.copy(event);
            if (c) { if (scrollTemplate) scrollPost.release(scrollTemplate.ev); scrollTemplate = { ev: c, pid: Number(getInt(event, 40)), at: Date.now() }; }
          }
          const res = onScroll(-dx, -dy, info);
          if (res === true) return null; // swallow
          if (typeof res === 'number' && res !== 0 && scrollPost) scaleWheel(event, res); // keep the system's own glide, change only how far it goes
          return event;
        }
      } catch {}
      return event;
    }, koffi.pointer(TapCb));
    port = create(1 /* session */, 0 /* head */, 0 /* active: may swallow */, (1n << 22n) | (1n << 25n) | (1n << 26n) | (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n), cb, null);
    if (!port) { console.error('[island] scroll tap not created (Accessibility permission?)'); return false; }
    addSource(mainLoop(), makeSource(null, port, 0), commonModes);
    enable(port, true);
    scrollTap = { port, cb };
    return true;
  } catch (e) {
    console.error('[island] scroll tap failed:', e.message);
    return false;
  }
}

// ---- macOS: files being dragged ---------------------------------------------------------------------------
// Dropping on the panel window does not always reach the page (the window is a non-activating panel), so the files that are
// being dragged are read from the system's drag pasteboard instead, and the drop is recognised from the mouse button.
let objc = null;
function loadObjc() {
  if (objc !== null) return objc;
  objc = false;
  if (process.platform !== 'darwin' || !koffi) return objc;
  try {
    const lib = koffi.load('/usr/lib/libobjc.dylib');
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
    objc = {
      cls: lib.func('void *objc_getClass(const char *name)'),
      sel: lib.func('void *sel_registerName(const char *name)'),
      p0: lib.func('void *objc_msgSend(void *self, void *sel)'),
      p1: lib.func('void *objc_msgSend(void *self, void *sel, void *a)'),
      s1: lib.func('void *objc_msgSend(void *self, void *sel, const char *a)'),
      i0: lib.func('int64_t objc_msgSend(void *self, void *sel)'),
      pi: lib.func('void *objc_msgSend(void *self, void *sel, uint64_t i)'),
      str: lib.func('const char *objc_msgSend(void *self, void *sel)'),
    };
  } catch (e) { console.error('[island] objc unavailable:', e.message); objc = false; }
  return objc;
}
const boards = new Map();
// { count, files }: count changes every time a new drag starts; files are absolute paths ([] when the drag carries none)
function macDragFiles(boardName = 'Apple CFPasteboard drag') {
  const o = loadObjc();
  if (!o) return null;
  try {
    const S = (s) => o.sel(s);
    const nsstr = (s) => o.s1(o.cls('NSString'), S('stringWithUTF8String:'), s);
    let dragBoard = boards.get(boardName);
    if (!dragBoard) { dragBoard = o.p1(o.cls('NSPasteboard'), S('pasteboardWithName:'), nsstr(boardName)); boards.set(boardName, dragBoard); }
    const count = Number(o.i0(dragBoard, S('changeCount')));
    const files = [];
    const list = o.p1(dragBoard, S('propertyListForType:'), nsstr('NSFilenamesPboardType'));
    if (list) {
      const len = Number(o.i0(list, S('count')));
      for (let i = 0; i < len && i < 200; i++) { const s = o.str(o.pi(list, S('objectAtIndex:'), BigInt(i)), S('UTF8String')); if (s) files.push(s); }
    } else {
      const u = o.p1(dragBoard, S('stringForType:'), nsstr('public.file-url'));
      if (u) { const s = o.str(u, S('UTF8String')); if (s && s.startsWith('file://')) files.push(decodeURIComponent(s.slice(7))); }
    }
    return { count, files };
  } catch (e) { console.error('[island] drag pasteboard failed:', e.message); return null; }
}

// macOS system shortcuts (Mission Control, move a space left / right) are posted the way the system itself reads them: the
// shortcut that is configured in System Settings is looked up and sent as hardware-like key events (idea from LinearMouse, MIT).
const HOTKEY = { spaceLeft: 79, spaceRight: 81, missionControl: 32 };
let hk = null;
function loadHotKeys() {
  if (hk !== null) return hk;
  hk = false;
  if (process.platform !== 'darwin' || !koffi) return hk;
  try {
    const cgs = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const ap = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    hk = {
      value: cgs.func('int CGSGetSymbolicHotKeyValue(uint32_t hotKey, _Out_ uint16_t *keyEq, _Out_ uint16_t *vk, _Out_ uint32_t *mods)'),
      enabled: cgs.func('bool CGSIsSymbolicHotKeyEnabled(uint32_t hotKey)'),
      setEnabled: cgs.func('int CGSSetSymbolicHotKeyEnabled(uint32_t hotKey, bool on)'),
      source: ap.func('void *CGEventSourceCreate(int32_t state)'),
      key: ap.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t vk, bool down)'),
      setFlags: ap.func('void CGEventSetFlags(void *event, uint64_t flags)'),
      setType: ap.func('void CGEventSetType(void *event, uint32_t type)'),
      post: ap.func('void CGEventPost(uint32_t tap, void *event)'),
      release: cf.func('void CFRelease(void *cf)'),
    };
  } catch (e) { console.error('[island] hotkeys unavailable:', e.message); hk = false; }
  return hk;
}
// the shortcut currently configured for a system action: { vk, mods, enabled } or null
function macHotKeyInfo(name) {
  const api = loadHotKeys();
  if (!api || !HOTKEY[name]) return null;
  try {
    const eq = [0], vk = [0], mods = [0];
    if (api.value(HOTKEY[name], eq, vk, mods) !== 0) return null;
    if (vk[0] === 0xffff || (vk[0] === 0 && eq[0] === 0xffff)) return null; // cleared in System Settings
    return { vk: vk[0], mods: mods[0] >>> 0, enabled: !!api.enabled(HOTKEY[name]) };
  } catch { return null; }
}
// true when the system shortcut was posted (false: not configured, the caller may send its own key chord)
function macPostHotKey(name) {
  const api = loadHotKeys(), info = macHotKeyInfo(name);
  if (!api || !info) return false;
  try {
    const id = HOTKEY[name];
    if (!info.enabled) api.setEnabled(id, true);
    const src = api.source(1 /* HID system state */);
    const MODS = [[0x20000, 0x38], [0x40000, 0x3b], [0x80000, 0x3a], [0x100000, 0x37]]; // shift, control, option, command
    const active = MODS.filter(([m]) => info.mods & m);
    const send = (vk, down, flags, type) => { const ev = api.key(src, vk, down); if (type) api.setType(ev, type); api.setFlags(ev, flags); api.post(1, ev); api.release(ev); };
    let acc = 0;
    for (const [m, vk] of active) { acc |= m; send(vk, true, acc, 12 /* flagsChanged */); }
    send(info.vk, true, info.mods); send(info.vk, false, info.mods);
    for (const [m, vk] of [...active].reverse()) { acc &= ~m; send(vk, false, acc, 12); }
    if (src) api.release(src);
    if (!info.enabled) setTimeout(() => { try { api.setEnabled(id, false); } catch {} }, 250);
    return true;
  } catch (e) { console.error('[island] hotkey post failed:', e.message); return false; }
}

// ---- live screen pixels (color picker) ------------------------------------------------------------------------------------
// An n x n block of pixels around (x, y), read from the screen right now (no screenshot kept): RGB bytes, or null.
// Windows: x, y in physical pixels (GetPixel on the screen DC). macOS: x, y in points (CGDisplayCreateImageForRect, needs Screen Recording).
let gdi = null, scr = null;
function screenPixels(x, y, n = 11) {
  try {
    if (process.platform === 'win32') {
      if (!koffi) return null;
      if (!gdi) { // one small BitBlt out of the screen is fast; GetPixel per pixel costs about 5 ms each
        const g = koffi.load('gdi32.dll'), u = koffi.load('user32.dll');
        koffi.struct('BMIH_ISL', { biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPels: 'int32_t', biYPels: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t', pad: 'uint32_t' });
        gdi = {
          getDC: u.func('void *__stdcall GetDC(void *hwnd)'), release: u.func('int __stdcall ReleaseDC(void *hwnd, void *dc)'),
          compat: g.func('void *__stdcall CreateCompatibleDC(void *dc)'), bitmap: g.func('void *__stdcall CreateCompatibleBitmap(void *dc, int w, int h)'),
          select: g.func('void *__stdcall SelectObject(void *dc, void *obj)'), blt: g.func('bool __stdcall BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32_t rop)'),
          bits: g.func('int __stdcall GetDIBits(void *dc, void *bmp, uint32_t start, uint32_t lines, void *buf, BMIH_ISL *info, uint32_t usage)'),
          delObj: g.func('bool __stdcall DeleteObject(void *obj)'), delDC: g.func('bool __stdcall DeleteDC(void *dc)'),
        };
      }
      const screen = gdi.getDC(null);
      if (!screen) return null;
      const mem = gdi.compat(screen), bmp = gdi.bitmap(screen, n, n), old = gdi.select(mem, bmp);
      const h = n >> 1, buf = Buffer.alloc(n * n * 4);
      let ok = gdi.blt(mem, 0, 0, n, n, screen, Math.round(x) - h, Math.round(y) - h, 0x00CC0020 /* SRCCOPY */);
      if (ok) ok = gdi.bits(mem, bmp, 0, n, buf, { biSize: 40, biWidth: n, biHeight: -n, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPels: 0, biYPels: 0, biClrUsed: 0, biClrImportant: 0, pad: 0 }, 0) > 0;
      gdi.select(mem, old); gdi.delObj(bmp); gdi.delDC(mem); gdi.release(null, screen);
      if (!ok) return null;
      const out = new Uint8Array(n * n * 3);
      for (let i = 0; i < n * n; i++) { out[i * 3] = buf[i * 4 + 2]; out[i * 3 + 1] = buf[i * 4 + 1]; out[i * 3 + 2] = buf[i * 4]; }
      return out;
    }
    if (process.platform === 'darwin') {
      if (!koffi) return null;
      if (!scr) {
        const ap = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
        const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
        try { koffi.struct('CGPoint', { x: 'double', y: 'double' }); } catch {}
        koffi.struct('CGRectISL', { x: 'double', y: 'double', w: 'double', h: 'double' });
        scr = {
          at: ap.func('int CGGetDisplaysWithPoint(CGPoint point, uint32_t max, _Out_ uint32_t *ids, _Out_ uint32_t *count)'),
          bounds: ap.func('CGRectISL CGDisplayBounds(uint32_t display)'),
          image: ap.func('void *CGDisplayCreateImageForRect(uint32_t display, CGRectISL rect)'),
          width: ap.func('size_t CGImageGetWidth(void *img)'),
          height: ap.func('size_t CGImageGetHeight(void *img)'),
          space: ap.func('void *CGColorSpaceCreateWithName(void *name)'),
          ctx: ap.func('void *CGBitmapContextCreate(void *data, size_t w, size_t h, size_t bpc, size_t rb, void *space, uint32_t info)'),
          draw: ap.func('void CGContextDrawImage(void *ctx, CGRectISL rect, void *img)'),
          data: ap.func('void *CGBitmapContextGetData(void *ctx)'),
          ctxRel: ap.func('void CGContextRelease(void *ctx)'),
          srgb: koffi.decode(ap.symbol('kCGColorSpaceSRGB', 'void *'), 'void *'),
          rowBytes: ap.func('size_t CGImageGetBytesPerRow(void *img)'),
          provider: ap.func('void *CGImageGetDataProvider(void *img)'),
          copy: ap.func('void *CGDataProviderCopyData(void *p)'),
          ptr: cf.func('void *CFDataGetBytePtr(void *d)'),
          len: cf.func('long CFDataGetLength(void *d)'),
          rel: cf.func('void CFRelease(void *c)'),
        };
      }
      const ids = [0], cnt = [0];
      if (scr.at({ x, y }, 1, ids, cnt) !== 0 || !cnt[0]) return null;
      const b = scr.bounds(ids[0]), h = n >> 1;
      const img = scr.image(ids[0], { x: x - h - b.x, y: y - h - b.y, w: n, h: n });
      if (!img) return null;
      try {
        // the display's own color space (often Display P3) is converted to sRGB by drawing into an sRGB bitmap
        const w = Number(scr.width(img)), ht = Number(scr.height(img));
        if (!scr.space1) scr.space1 = scr.space(scr.srgb);
        const ctx = scr.ctx(null, w, ht, 8, w * 4, scr.space1, 8198 /* skip-first alpha, 32-bit little endian: B, G, R, x */);
        if (!ctx) return null;
        scr.draw(ctx, { x: 0, y: 0, w, h: ht }, img);
        const bytes = koffi.decode(scr.data(ctx), koffi.array('uint8_t', w * ht * 4)), rb = w * 4;
        const scale = Math.max(1, Math.round(w / n)), out = new Uint8Array(n * n * 3);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
          const o = Math.floor((j + 0.5) * scale) * rb + Math.floor((i + 0.5) * scale) * 4, p = (j * n + i) * 3;
          out[p] = bytes[o + 2]; out[p + 1] = bytes[o + 1]; out[p + 2] = bytes[o];
        }
        scr.ctxRel(ctx);
        return out;
      } finally { scr.rel(img); }
    }
  } catch (e) { if (!screenPixels.warned) { screenPixels.warned = true; console.error('[island] screen pixels failed:', e.message); } }
  return null;
}

// Media keys (play/pause, next, previous) as the system sends them: a system-defined event with the key code in data1. This works
// for whatever player owns "now playing" (Spotify, Music, a browser tab).
let mediaFns = null;
function macMediaKey(name) {
  const code = { play: 16, next: 17, prev: 18 }[name];
  if (!code || process.platform !== 'darwin' || !koffi) return false;
  try {
    if (!mediaFns) {
      const o = loadObjc(), ap = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
      const lib = koffi.load('/usr/lib/libobjc.dylib');
      try { koffi.struct('NSPointISL', { x: 'double', y: 'double' }); } catch {}
      mediaFns = {
        o,
        event: lib.func('void *objc_msgSend(void *self, void *sel, uint64_t type, NSPointISL loc, uint64_t flags, double ts, int64_t win, void *ctx, int16_t sub, int64_t d1, int64_t d2)'),
        post: ap.func('void CGEventPost(uint32_t tap, void *event)'),
      };
    }
    const { o, event, post } = mediaFns;
    const cls = o.cls('NSEvent'), sel = o.sel('otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:'), cg = o.sel('CGEvent');
    for (const down of [true, false]) {
      const flags = down ? 0xa00 : 0xb00;
      const ev = event(cls, sel, 14 /* NSEventTypeSystemDefined */, { x: 0, y: 0 }, flags, 0, 0, null, 8, (code << 16) | flags, -1);
      const c = ev && o.p0(ev, cg);
      if (c) post(0 /* HID event tap */, c);
    }
    return true;
  } catch (e) { console.error('[island] media key failed:', e.message); return false; }
}

const macMouse = {
  // is the left button held down right now (a drag is under way)
  leftDown: () => { try { const api = loadCG(); if (!api.btn) api.btn = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices').func('bool CGEventSourceButtonState(int32_t state, uint32_t button)'); if (api.btn(1, 0)) return true; } catch {}
    // CGEventSourceButtonState reads false for real drags on some Macs: ask AppKit for the held buttons too (bit 0 = left)
    try { const o = loadObjc(); return !!(o && (Number(o.i0(o.cls('NSEvent'), o.sel('pressedMouseButtons'))) & 1)); } catch { return false; } },
  available: () => !!loadCG(),
  // Hide the pointer system-wide (not just over our own window), e.g. while the other computer is being controlled.
  // "SetsCursorInBackground" lets an app that is not frontmost hide the cursor as well.
  hideCursor: (hide) => {
    try {
      const api = loadCG();
      if (!api) return false;
      if (hide && !cursorHiddenByUs) {
        api.setProp(api.connection(), api.connection(), api.cfString(null, 'SetsCursorInBackground', 0x08000100), api.cfTrue);
        api.hide(0);
        cursorHiddenByUs = true;
      } else if (!hide && cursorHiddenByUs) {
        api.show(0);
        cursorHiddenByUs = false;
      }
      return true;
    } catch (e) { console.error('[island] cursor hide failed:', e.message); return false; }
  },
  // true if a real mouse/trackpad moved in the last ~50 ms. Events we post ourselves never count here,
  // because only hardware events update the HID system state.
  recentPhysical: () => {
    try {
      const api = loadCG();
      if (!api) return null;
      return [5, 6, 7, 27].some((t) => api.hidIdle(1 /* HID system state */, t) < 0.05);
    } catch { return null; }
  },
  cursorVisible: () => { try { const api = loadCG(); return api ? !!api.visible() : null; } catch { return null; } },
  // where the cursor really is (the system may have refused a move, e.g. around the notch or the Dock)
  pos: () => {
    try {
      const api = loadCG();
      if (!api) return null;
      const ev = api.createEmpty(null);
      const p = api.location(ev);
      api.release(ev);
      return { x: p.x, y: p.y };
    } catch { return null; }
  },
  // pixel scroll; positive wheel1 scrolls up, positive wheel2 scrolls left
  scroll: (wheel1, wheel2, local) => {
    try {
      const api = loadCG();
      if (!api) return false;
      // this computer's own wheel, smoothed: a copy of the real event goes straight to the application it was meant for
      if (local && scrollTemplate && scrollPost && scrollTemplate.pid > 0 && Date.now() - scrollTemplate.at < 3000) {
        const ev = scrollPost.copy(scrollTemplate.ev);
        scrollPost.setI(ev, 11, 0); scrollPost.setI(ev, 12, 0); // no coarse line delta, only exact pixels
        scrollPost.setD(ev, 96, wheel1); scrollPost.setD(ev, 97, wheel2);
        scrollPost.setD(ev, 93, wheel1); scrollPost.setD(ev, 94, wheel2);
        scrollPost.setI(ev, 88, 1); scrollPost.setI(ev, 42, 0x1517);
        scrollPost.toPid(scrollTemplate.pid, ev);
        scrollPost.release(ev);
        return true;
      }
      const ev = api.scroll(null, 0 /* pixel units */, 2, wheel1, wheel2, 0);
      api.setInt(ev, 88, 1);      // precise pixel scrolling, like a trackpad: pages move smoothly
      api.setInt(ev, 42, 0x1517); // marks the event as ours so the scroll tap does not smooth it again
      api.post(1, ev);
      api.release(ev);
      return true;
    } catch (e) { console.error('[island] scroll failed:', e.message); return false; }
  },
  move: (x, y, heldButton) => macPost(heldButton && CG_BUTTON[heldButton] ? CG_BUTTON[heldButton].drag : 5, x, y, heldButton && CG_BUTTON[heldButton] ? CG_BUTTON[heldButton].n : 0),
  down: (b, x, y, state) => CG_BUTTON[b] && macPost(CG_BUTTON[b].down, x, y, CG_BUTTON[b].n, state || 1),
  up: (b, x, y, state) => CG_BUTTON[b] && macPost(CG_BUTTON[b].up, x, y, CG_BUTTON[b].n, state || 1),
};

// macOS: is Input Monitoring allowed? true / false, or null when the system does not say (then it is treated as allowed)
let hidCheck = null;
function macInputMonitoring() {
  if (process.platform !== 'darwin' || !koffi) return null;
  try {
    if (!hidCheck) hidCheck = koffi.load('/System/Library/Frameworks/IOKit.framework/IOKit').func('uint32_t IOHIDCheckAccess(uint32_t type)');
    const r = hidCheck(1); // kIOHIDRequestTypeListenEvent; 0 = granted, 1 = denied, 2 = not decided yet
    return r === 0 ? true : r === 1 ? false : null;
  } catch { return null; }
}

module.exports = { macInputMonitoring, macDisplaySizes, winMonitorSizes, refreshWinMonitorSizes, matchSizes, reinstallHooks, removeHooks, winIdleMs, winModsHeld, installScrollTap, highResTimer, winCursor, setCursorHidden, installKeyBlocker, installMouseHook, macMouse, macMediaKey, macDragFiles, screenPixels, macHotKeyInfo, macPostHotKey, loadWin: () => loadWin() };
