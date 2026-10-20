const { WebSocketServer, WebSocket } = require('ws');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const L = require('./layout');
const S = require('./secure');
const HK = require('./hotkeys');
const { SecureChannel } = S;

// What a mapped mouse button / thumb wheel can do on the computer that is being operated (key chords per platform)
const ACTIONS = {
  desktopLeft: { darwin: [['Ctrl'], 'ArrowLeft'], win32: [['Ctrl', 'Meta'], 'ArrowLeft'] },
  desktopRight: { darwin: [['Ctrl'], 'ArrowRight'], win32: [['Ctrl', 'Meta'], 'ArrowRight'] },
  missionControl: { darwin: [['Ctrl'], 'ArrowUp'], win32: [['Meta'], 'Tab'] },
  back: { darwin: [['Meta'], 'BracketLeft'], win32: [['Alt'], 'ArrowLeft'] },
  forward: { darwin: [['Meta'], 'BracketRight'], win32: [['Alt'], 'ArrowRight'] },
  screenshot: { darwin: [['Meta', 'Shift'], '4'], win32: [['Meta', 'Shift'], 'S'] },
};
const { WheelSmoother, DEFAULT_TUNE } = require('./smooth');

const PORT = Number(process.env.ISLAND_PORT) || 47800;
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const DRIFT = 150;
const native = require('./native');
// mouse messages -> [button, direction]
const BTN = { 0x201: ['L', 'down'], 0x202: ['L', 'up'], 0x204: ['R', 'down'], 0x205: ['R', 'up'], 0x207: ['M', 'down'], 0x208: ['M', 'up'] };
const DOM_NAMES = {
  ControlLeft: 'Ctrl', ControlRight: 'CtrlRight', AltLeft: 'Alt', AltRight: 'AltRight',
  ShiftLeft: 'Shift', ShiftRight: 'ShiftRight', MetaLeft: 'Meta', MetaRight: 'MetaRight',
};

const randomPin = () => String(crypto.randomInt(100000, 1000000));

// Shares this computer's pointer with one paired peer. Whichever machine the
// cursor is on is the "controller"; crossing the configured screen edge hands
// control to the other machine.
class Link extends EventEmitter {
  constructor({ input, getDisplays, store, downloadDir, diag, port }) {
    super();
    this.diag = diag || null;
    this.basePort = port || PORT; // the port this computer is expected on (the one other computers try)
    this.port = this.basePort; // the port it really listens on: a stuck leftover of an earlier run can hold the usual one
    this.lastMoveRx = 0;
    this.pingTimer = null;
    this.downloadDir = downloadDir;
    this.rx = null;
    this.sendQueue = Promise.resolve();
    this.input = input;
    this.getDisplays = getDisplays;
    this.myDisplays = getDisplays();
    this.peer = null; // { id, name, plat, displays }
    this.id = store.get('deviceId', null) || (() => { const v = crypto.randomBytes(8).toString('hex'); store.set('deviceId', v); return v; })();
    this.offsets = store.get('offsets', {}); // device id -> position of its screens in the shared plane
    this.store = store;
    this.pin = randomPin();
    this.sock = null;
    this.peerName = null;
    this.peerSide = 'right'; // where the peer sits relative to this screen
    this.ignoreButtonsUntil = 0;
    this.locked = false; // overlay has the pointer locked: movement arrives as relative deltas
    this.awaitAnchor = 0;
    this.relMoves = 0;
    this.sideHeld = new Set();
    this.swallowedBtn = new Set();
    this.xDown = new Set();
    this.xTimers = new Map();
    this.xChord = new Set();
    this.xReplayed = new Set();
    this.chordActive = false;
    // a glide for mouse-wheel notches: this computer's own wheel, and wheel notches coming in from the other computer
    this.localSmooth = new WheelSmoother((dx, dy) => { this.injectAt = Date.now(); this.input.scroll(dx, dy, this.scrollSettings.speed, this.scrollSettings.reverse, true); }, () => this.scrollTune, { onGlide: (g) => this.glideLog('local', g) });
    this.remoteSmooth = new WheelSmoother((dx, dy) => { this.injectAt = Date.now(); this.input.scroll(dx, dy, this.scrollSettings.speed, this.scrollSettings.reverse, false, true); }, () => this.scrollTune, { onGlide: (g) => this.glideLog('remote', g) });
    this.scrollX = 0;
    this.scrollY = 0;
    this.scrollTimer = null;
    this.lastOverlayWheel = 0;
    this.scrollSettings = { speed: 1, reverse: false };
    this.scrollTune = { ...DEFAULT_TUNE }; // per device: never sent to the other computer
    this.picker = null; // set while the live color picker is running
    this.buttonMap = {}; // per device: tiltLeft / tiltRight / back / forward -> action id (default when missing)
    this.hotkeys = []; // keyboard shortcuts of this computer: [{ combo, action }]
    this.recorder = null; // set while the settings window records a key combination
    this.rMods = new Set(); // modifiers held on the other computer's keyboard while it controls this one
    this.hotSwallow = new Set();
    this.injecting = 0;
    this.lastAct = {};
    this.xSent = new Set();
    this.lastFlush = 0;
    this.inX = 0;
    this.inY = 0;
    this.smoothTimer = null;
    this.pendX = 0;
    this.pendY = 0;
    this.pendTimer = null;
    this.external = false; // a native mouse hook (Windows) delivers movement deltas and swallows local input
    this.mismatch = 0;
    this.hookMismatch = 0;
    this.parkUntil = 0;
    this.farMoves = 0;
    this.recent = []; // positions this computer injected lately: anything else moving the cursor is the user's own mouse
    this.relIgnoreUntil = 0;
    this.prefs = { edgeResistance: 20, freelookGuard: true, smoothWheel: true }; // px of push needed before crossing; keep out of games
    this.pushDist = 0;
    this.edgeEvents = 0;
    this.buttonsDown = new Set();
    this.freelookAt = 0;
    this.freelookVal = false;
    this.ctrlMpp = 0; // millimetres per pixel on the computer that is controlling this one
    this.owner = null; // where the pointer is: 'me' (on my screens), 'peer', or null before anyone moved
    this.lastIdle = null;
    this.hookMovesLocked = 0;
    this.lastHookKey = 0;
    this.peerPlat = process.platform;
    this.state = 'idle'; // idle | controlling | controlled
    this.last = { x: 0, y: 0 };
    this.virt = { x: 0, y: 0 };
    this.cooldownUntil = 0;
    this.entrySide = null;
  }

  get state() { return this._state; }
  set state(v) {
    const prev = this._state;
    this._state = v;
    if (prev === v) return;
    this.d('state', { from: prev, to: v });
    if (v === 'controlling') this.owner = 'peer';
    else if (v === 'controlled') this.owner = 'me';
    if (v === 'controlling') { this.ignoreButtonsUntil = Date.now() + 150; this.awaitAnchor = Date.now() + 400; this.emit('capture', true); }
    else if (prev === 'controlling') this.emit('capture', false);
    if (prev === 'controlled') this.input.releaseAll();
    if (prev === 'controlled') { this.rMods.clear(); this.hotSwallow.clear(); }
    // this computer's screen became the active one (the pointer arrived, or came back): the screen-edge effect listens to this
    if (this.peer && (v === 'controlled' || (v === 'idle' && prev === 'controlling'))) this.emitSwitch(v, prev);
  }

  // Listens on the usual port, or on the next free one when something (a stuck leftover of an earlier run) holds it. The port is announced to
  // the other computers (discovery) and remembered with the recent computers, so they find it.
  start() { this.listen(this.basePort, 0); }
  listen(port, tried) {
    const srv = new WebSocketServer({ port });
    this.server = srv;
    srv.on('connection', (ws) => this.accept(ws));
    srv.on('listening', () => {
      this.port = port;
      if (tried) { try { require('./lifecycle').line('link: port ' + this.basePort + ' is taken, listening on ' + port); } catch {} }
      this.notify();
    });
    srv.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && tried < 9) { try { srv.close(); } catch {} this.listen(port + 1, tried + 1); return; }
      this.emit('error', e && e.message);
    });
  }

  // Close everything the network side holds. A hard exit with sockets still open can leave the process stuck while the system waits for
  // the network driver, so every connection is terminated explicitly and the timers are stopped.
  stop() {
    clearInterval(this.pingTimer); this.pingTimer = null;
    try { if (this.server) { for (const c of this.server.clients) { try { c.terminate(); } catch {} } this.server.close(); } } catch {}
    try { if (this.sock) { try { this.sock.terminate(); } catch { this.sock.close(); } } } catch {}
    this.server = null; this.sock = null;
  }

  status() {
    return {
      pin: this.pin,
      port: this.port,
      addresses: Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address),
      name: os.hostname(),
      platform: process.platform,
      connected: !!this.sock,
      peerName: this.peerName,
      peerPlat: this.peer && this.peer.plat,
      peerId: this.peer && this.peer.id,
      peerSide: this.peer && this.peer.displays.length && this.myDisplays.length ? L.sideOf(this.myDisplays, this.myOff(), this.peer.displays, this.peerOff()) : this.peerSide,
      state: this.state,
    };
  }

  notify() { this.emit('status', this.status()); }

  send(msg) {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) this.sock.send(JSON.stringify(msg));
  }

  // ---- pairing -------------------------------------------------------
  // A connection is first encrypted (secure.js); the pairing code / token is never sent, only a proof that is tied to this one session.
  accept(rawWs) {
    const ws = new SecureChannel(rawWs, 'server');
    let authed = false, pending = null;
    let hsTimer = setTimeout(() => { if (!authed) ws.terminate(); }, 8000);
    const line = (t) => { try { require('./lifecycle').line(t); } catch {} };
    ws.on('error', (e) => line('link: connection refused: ' + e.message));
    // everything that has to be true before this computer lets the other one in
    const finish = (m, secret, via) => {
      authed = true;
      clearTimeout(hsTimer);
      this.sasDone(ws);
      this.authFails = [];
      const token = crypto.randomBytes(16).toString('hex');
      this.store.set('tokens', [...this.store.get('tokens', []), token].slice(-10));
      this.pin = randomPin();
      this.attach(ws, m.info, OPPOSITE[m.side] || 'left', ws.remoteAddress);
      ws.send(JSON.stringify({ t: 'ok', token, info: this.info(), via, sproof: S.proof(secret, 'ok', ws.binding) }));
    };
    const settle = () => { if (pending && pending.local && pending.remote) { const p = pending; pending = null; finish(p.m, p.secret, p.via); } };
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { if (authed) this.onBinary(raw); return; }
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (authed) return this.onMessage(m);
      if (pending) { // first pairing with a code: both people must confirm they see the same number
        if (m.t === 'sas-ok') { pending.remote = true; settle(); }
        else if (m.t === 'sas-no') { line('link: the other side said the pairing numbers do not match'); this.sasDone(ws); ws.close(); }
        return;
      }
      if (m.t !== 'hello') return;
      if (this.lockedUntil > Date.now()) { ws.send(JSON.stringify({ t: 'denied', locked: true })); ws.close(); return; }
      const tokens = this.store.get('tokens', []);
      let via = null, secret = null;
      if (m.tokenProof) { const t = tokens.find((x) => S.check(x, 'hello', ws.binding, m.tokenProof)); if (t) { via = 'token'; secret = t; } }
      if (!via && S.check(this.pin, 'hello', ws.binding, m.pinProof)) { via = 'pin'; secret = this.pin; }
      if (!via) {
        line('link: sign-in refused: ' + tokens.length + ' saved tokens here, the other side sent ' + (m.tokenProof ? 'a token proof' : 'no token') + ' and ' + (m.pinProof ? 'a code proof' : 'no code'));
        // too many wrong codes: lock for a minute and change the code, so it cannot be guessed by trying
        const now = Date.now();
        // only wrong CODES count: a stale token (the other side tries again every few seconds) is not a guess, and must not lock real pairing out
        if (m.pinProof) this.authFails = (this.authFails || []).filter((x) => now - x < 60000).concat(now);
        if ((this.authFails || []).length >= 5) { this.lockedUntil = now + 60000; this.authFails = []; this.pin = randomPin(); this.notify(); line('link: 5 wrong pairing attempts, locked for 60 s and the code was changed'); }
        ws.send(JSON.stringify({ t: 'denied' })); ws.close(); return;
      }
      if (via === 'token') return finish(m, secret, via);
      pending = { m, secret, via, local: false, remote: false };
      clearTimeout(hsTimer);
      hsTimer = setTimeout(() => { if (!authed) { this.sasDone(ws); ws.terminate(); } }, 90000);
      ws.send(JSON.stringify({ t: 'sas', sproof: S.proof(secret, 'sas', ws.binding) }));
      this.askSas(ws, 'server', m.info && m.info.name, (yes) => {
        if (yes) { pending.local = true; ws.send(JSON.stringify({ t: 'sas-ok' })); settle(); }
        else { ws.send(JSON.stringify({ t: 'denied', sas: true })); ws.close(); }
      });
    });
    ws.on('close', () => { clearTimeout(hsTimer); this.sasDone(ws); this.detach(ws); });
  }

  // First pairing: both computers show the same 6 numbers, derived from this one encrypted session. If someone sits in the middle, the two
  // sessions differ and so do the numbers, so people see it and say no. The window that shows them lives in main.js (event 'sas').
  askSas(ws, role, name, cb) {
    this.sasWait = { ws, cb };
    this.emit('sas', { code: S.sas(ws.binding), name: name || '', role });
  }
  sasDone(ws) { if (this.sasWait && this.sasWait.ws === ws) { this.sasWait = null; this.emit('sas-end'); } }
  sasAnswer(yes) {
    const w = this.sasWait;
    if (!w) return false;
    this.sasWait = null;
    this.emit('sas-end');
    w.cb(!!yes);
    return true;
  }

  connect(host, pin, side, peerId, port, noToken) {
    return new Promise((resolve, reject) => {
      const ws = new SecureChannel(new WebSocket(`ws://${host}:${port || this.basePort}`), 'client');
      this.dialPort = port || this.basePort;
      let timer = setTimeout(() => { ws.terminate(); reject(new Error('Timeout')); }, 5000);
      const saved = noToken ? null : (this.store.get('peers', {})[host] || (peerId && this.store.get('peerTokens', {})[peerId])); // the saved token also works from a new address
      ws.on('ready', () => ws.send(JSON.stringify({
        t: 'hello', side, info: this.info(),
        pinProof: pin ? S.proof(pin, 'hello', ws.binding) : undefined,
        tokenProof: saved ? S.proof(saved, 'hello', ws.binding) : undefined,
      })));
      ws.on('message', (raw, isBinary) => {
        if (isBinary) { this.onBinary(raw); return; }
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'denied') { clearTimeout(timer); this.sasDone(ws); reject(new Error(m.sas ? 'The other computer said the pairing numbers do not match' : m.locked ? 'Too many wrong codes: try again in a minute' : 'Wrong pairing code')); return; }
        if (m.t === 'sas') {
          // the other computer knows the code; now both people compare the numbers
          if (!pin || !S.check(pin, 'sas', ws.binding, m.sproof)) { ws.terminate(); reject(new Error('The other computer could not prove its identity')); return; }
          clearTimeout(timer);
          timer = setTimeout(() => { this.sasDone(ws); ws.terminate(); reject(new Error('Timeout')); }, 90000);
          this.askSas(ws, 'client', '', (yes) => {
            if (yes) ws.send(JSON.stringify({ t: 'sas-ok' }));
            else { clearTimeout(timer); ws.send(JSON.stringify({ t: 'sas-no' })); ws.close(); reject(new Error('Pairing cancelled: the numbers did not match')); }
          });
          return;
        }
        if (m.t === 'ok') {
          clearTimeout(timer);
          this.sasDone(ws);
          // the other side has to prove it knows the same secret, otherwise something sits between us
          if (!S.check(m.via === 'token' ? saved : pin, 'ok', ws.binding, m.sproof)) { ws.terminate(); reject(new Error('The other computer could not prove its identity')); return; }
          this.store.set('peers', { ...this.store.get('peers', {}), [host]: m.token });
          if (m.info && m.info.id) this.store.set('peerTokens', { ...this.store.get('peerTokens', {}), [m.info.id]: m.token });
          this.attach(ws, m.info, side, host);
          this.initLayout(side);
          // give the other computer a token too, so it can connect back to us without a pairing code
          const back = crypto.randomBytes(16).toString('hex');
          this.store.set('tokens', [...this.store.get('tokens', []), back].slice(-10));
          this.send({ t: 'rtoken', token: back });
          resolve();
          return;
        }
        this.onMessage(m);
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => { clearTimeout(timer); this.sasDone(ws); this.detach(ws); });
    });
  }

  info() { return { id: this.id, name: os.hostname(), plat: process.platform, displays: this.myDisplays }; }

  attach(ws, info, side, host) {
    this.sock && this.sock !== ws && this.sock.close();
    this.sock = ws;
    this.owner = null;
    this.peerHost = host;
    clearInterval(this.pingTimer);
    this.lastRx = Date.now();
    this.manualDisconnect = false;
    this.pingTimer = setInterval(() => {
      // a cable pulled or a Wi-Fi drop leaves a connection that looks open on this side only: nothing came back for 8 s means it is gone
      if (Date.now() - this.lastRx > 8000) { try { require('./lifecycle').line('link: no answer from the other computer for 8 s, closing the connection'); } catch {} try { ws.terminate(); } catch {} return; }
      this.send({ t: 'ping', ts: Date.now() });
    }, 2000);
    if (this.pingTimer.unref) this.pingTimer.unref();
    if (info && info.id && host) {
      const recent = this.store.get('recent', {});
      const prevPort = recent[info.id] && recent[info.id].port;
      recent[info.id] = { id: info.id, name: info.name, host, side, lastSeen: Date.now(), port: this.dialPort || prevPort || undefined };
      this.dialPort = null;
      this.store.set('recent', recent);
      this.dedupeRecent();
    }
    this.peer = { id: info.id, name: info.name, plat: info.plat, displays: info.displays || [] };
    this.peerName = info.name;
    this.peerSide = side;
    this.peerPlat = info.plat || process.platform;
    this.migrateOffsets();
    this.state = 'idle';
    this.notify();
    this.emit('layout');
  }

  // Layouts used to be stored in screen points; the shared plane is millimetres now. Keep the relation between the
  // two computers: this one is rescaled, the other is placed where it was relative to this one.
  migrateOffsets() {
    if (this.store.get('offsetUnits', 'dip') === 'mm' || !this.peer) return;
    const mineMain = (this.myDisplays.find((d) => d.dx === 0 && d.dy === 0) || this.myDisplays[0]);
    const peerMain = (this.peer.displays.find((d) => d.dx === 0 && d.dy === 0) || this.peer.displays[0]);
    const sMine = mineMain && mineMain.s, sPeer = peerMain && peerMain.s;
    const mine = this.offsets[this.id], peer = this.offsets[this.peer.id];
    if (!sMine || !sPeer || !mine || !peer) { this.offsets = {}; this.store.set('offsets', {}); this.store.set('offsetUnits', 'mm'); return; }
    // Which side was the other computer on, and how far along that side, in the old screen-point plane?
    const a = { x: mine.x, y: mine.y, w: mineMain.dw / sMine, h: mineMain.dh / sMine };
    const b = { x: peer.x, y: peer.y, w: peerMain.dw / sPeer, h: peerMain.dh / sPeer };
    const dx = (b.x + b.w / 2 - a.x - a.w / 2) / ((a.w + b.w) / 2), dy = (b.y + b.h / 2 - a.y - a.h / 2) / ((a.h + b.h) / 2);
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
    // millimetres have no shared pixel size, so rebuild it: edges touching on that side, the along-the-edge shift kept
    const main = (ds) => { const m = ds.filter((d) => d.dx === 0 && d.dy === 0); return m.length ? m : ds; };
    const newMine = { x: mine.x * sMine, y: mine.y * sMine };
    const newPeer = L.placeBeside(main(this.myDisplays), newMine, main(this.peer.displays), side);
    if (side === 'left' || side === 'right') newPeer.y += (b.y - a.y) * sPeer; else newPeer.x += (b.x - a.x) * sPeer;
    this.offsets = { [this.id]: newMine, [this.peer.id]: newPeer };
    this.store.set('offsets', this.offsets);
    this.store.set('offsetUnits', 'mm');
  }

  // ---- recent devices ----------------------------------------------------
  // The same computer can show up under two device ids (its settings folder was reset, or it ran with a second profile). One name at one
  // address is one computer: only the newest entry is kept.
  dedupeRecent() {
    const recent = this.store.get('recent', {});
    const newest = {};
    for (const e of Object.values(recent)) { const k = e.name + '|' + e.host; if (!newest[k] || e.lastSeen > newest[k].lastSeen) newest[k] = e; }
    const keep = new Set(Object.values(newest).map((e) => e.id));
    let changed = false;
    for (const id of Object.keys(recent)) if (!keep.has(id)) { delete recent[id]; changed = true; }
    if (changed) this.store.set('recent', recent);
    return recent;
  }

  recentList() {
    return Object.values(this.dedupeRecent()).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  forgetRecent(id) {
    const recent = this.store.get('recent', {});
    const r = recent[id];
    delete recent[id];
    this.store.set('recent', recent);
    if (r) { const peers = this.store.get('peers', {}); delete peers[r.host]; this.store.set('peers', peers); }
  }

  // ---- screen layout ----------------------------------------------------
  myOff() { return this.offsets[this.id] || { x: 0, y: 0 }; }
  peerOff() { return (this.peer && this.offsets[this.peer.id]) || { x: 0, y: 0 }; }

  // the connecting side decides the first arrangement from the chosen side; later edits happen in the arrange window
  initLayout(side) {
    if (!this.peer) return;
    if (!this.offsets[this.peer.id] || !this.offsets[this.id]) {
      this.offsets[this.id] = this.myOff();
      // place it beside the main screen of each computer (not beside the whole desktop bounding box)
      const main = (ds) => { const m = ds.filter((d) => d.dx === 0 && d.dy === 0); return m.length ? m : ds; };
      this.offsets[this.peer.id] = L.placeBeside(main(this.myDisplays), this.myOff(), main(this.peer.displays), side);
      this.store.set('offsets', this.offsets);
    }
    this.sendLayout();
    this.emit('layout');
  }

  // The other computer's screens are put beside this computer's main screen, on the chosen side (the Arrange window shows the same)
  setSide(side) {
    if (!this.peer || !['left', 'right', 'top', 'bottom'].includes(side)) return false;
    const main = (ds) => { const m = ds.filter((d) => d.dx === 0 && d.dy === 0); return m.length ? m : ds; };
    if (!this.myDisplays.length || !(this.peer.displays || []).length) return false;
    this.offsets[this.id] = this.myOff();
    this.offsets[this.peer.id] = L.placeBeside(main(this.myDisplays), this.myOff(), main(this.peer.displays), side);
    this.store.set('offsets', this.offsets);
    this.peerSide = side;
    this.rememberSide();
    this.d('layout', { side });
    this.sendLayout();
    this.emit('layout');
    this.notify();
    return true;
  }

  // the side saved for "recent devices" is the one the layout really has now
  rememberSide() {
    try {
      if (!this.peer) return;
      const side = this.peer.displays.length && this.myDisplays.length ? L.sideOf(this.myDisplays, this.myOff(), this.peer.displays, this.peerOff()) : this.peerSide;
      const recent = this.store.get('recent', {});
      if (recent[this.peer.id]) { recent[this.peer.id].side = side; this.store.set('recent', recent); }
    } catch {}
  }

  sendLayout() {
    if (!this.peer) return;
    this.send({ t: 'layout', units: 'mm', offsets: { [this.id]: this.myOff(), [this.peer.id]: this.peerOff() } });
  }

  setOffset(id, x, y) {
    this.offsets[id] = { x, y };
    this.store.set('offsets', this.offsets);
    this.rememberSide();
    this.sendLayout();
    this.emit('layout');
    this.notify();
  }

  setDisplays(list) {
    this.myDisplays = list;
    this.send({ t: 'displays', displays: list });
    this.emit('layout');
  }

  layoutState() {
    const strip = (ds) => ds.map((d) => ({ x: d.dx, y: d.dy, w: d.dw, h: d.dh, mmw: d.mmw, mmh: d.mmh }));
    return {
      self: { id: this.id, name: os.hostname(), displays: strip(this.myDisplays), off: this.myOff() },
      peer: this.peer ? { id: this.peer.id, name: this.peer.name, displays: strip(this.peer.displays), off: this.peerOff() } : null,
    };
  }

  detach(ws) {
    if (this.sock !== ws) return;
    if (this.peer && !this.manualDisconnect) this.emit('lost', { id: this.peer.id, name: this.peer.name, host: this.peerHost, side: this.peerSide });
    this.sock = null;
    clearInterval(this.pingTimer);
    this.owner = null;
    this.peerName = null;
    this.peer = null;
    this.lastPeerPlane = null;
    this.state = 'idle';
    this.notify();
    this.emit('layout');
  }

  disconnect() { this.manualDisconnect = true; this.sock && this.sock.close(); }

  // ---- file transfer ---------------------------------------------------
  sendFile(filePath) {
    const job = this.sendQueue.then(() => this.doSend(filePath));
    this.sendQueue = job.catch(() => {});
    return job;
  }

  async doSend(filePath) {
    if (!this.sock) throw new Error('Not linked');
    const ws = this.sock;
    const { size } = await fs.promises.stat(filePath);
    const name = path.basename(filePath);
    ws.send(JSON.stringify({ t: 'file-start', name, size }));
    let sent = 0;
    this.emit('transfer', { dir: 'out', name, pct: 0 });
    for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 256 * 1024 })) {
      while (ws.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 15));
      if (ws.readyState !== WebSocket.OPEN) throw new Error('Link lost');
      ws.send(chunk, { binary: true });
      sent += chunk.length;
      this.emit('transfer', { dir: 'out', name, pct: size ? Math.round((sent / size) * 100) : 100 });
    }
    ws.send(JSON.stringify({ t: 'file-end' }));
    this.emit('transfer', { dir: 'out', name, pct: 100, done: true });
  }

  rxStart(m) {
    fs.mkdirSync(this.downloadDir, { recursive: true });
    const base = path.basename(String(m.name)) || 'file';
    const ext = path.extname(base), stem = path.basename(base, ext);
    let dest = path.join(this.downloadDir, base);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(this.downloadDir, `${stem} (${i})${ext}`);
    this.rx = { stream: fs.createWriteStream(dest), name: base, path: dest, size: m.size, got: 0 };
  }

  onBinary(buf) {
    this.lastRx = Date.now();
    if (!this.rx) return;
    this.rx.stream.write(buf);
    this.rx.got += buf.length;
    this.emit('transfer', { dir: 'in', name: this.rx.name, pct: this.rx.size ? Math.round((this.rx.got / this.rx.size) * 100) : 100 });
  }

  rxEnd() {
    const rx = this.rx;
    this.rx = null;
    if (!rx) return;
    rx.stream.end(() => this.emit('transfer', { dir: 'in', name: rx.name, pct: 100, done: true, path: rx.path }));
  }

  // ---- local input events (from the global hook) -----------------------
  physicalTakeback(why, x, y) {
    if (this.state !== 'controlled') return;
    console.log('[island] takeback by own mouse', why, x, y, 'expected near', JSON.stringify(this.recent.slice(-1)));
    this.dc('takeback');
    this.d('takeback', { why, at: { x: Math.round(x), y: Math.round(y) }, expected: this.recent.slice(-1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))[0] });
    this.state = 'idle';
    this.owner = 'me';
    this.cooldownUntil = Date.now() + 150;
    this.mismatch = 0;
    this.send({ t: 'takeback' });
    this.emitSwitch('idle', 'controlled');
    this.notify();
  }

  // Side buttons: hold back each press for a moment. Pressed together they form the screenshot chord and the
  // system never sees either of them; a single press is replayed to the system so back/forward still work.
  onXButton(msg, i) {
    const which = (i.mouseData >>> 16) & 0xffff; // 1 = back, 2 = forward
    const id = which === 2 ? 5 : 4;              // the numbering the global hook uses
    const other = id === 4 ? 5 : 4;
    if (msg === 0x20B) {
      this.xDown.add(id);
      this.xTimers.set(id, setTimeout(() => {
        this.xTimers.delete(id);
        if (this.xDown.has(id) && !this.xChord.has(id)) { if (this.xHandle(id)) this.xSent.add(id); else { this.xReplayed.add(id); native.winCursor.xbutton(which, true); } }
      }, 70));
      if (this.xDown.has(other) && !this.xChord.has(other)) {
        for (const k of [id, other]) {
          clearTimeout(this.xTimers.get(k)); this.xTimers.delete(k);
          if (this.xReplayed.delete(k)) native.winCursor.xbutton(k === 5 ? 2 : 1, false); // the system already saw this press: release it
          this.xChord.add(k);
        }
      }
      return true;
    }
    this.xDown.delete(id);
    if (this.xSent.delete(id)) return true;
    if (this.xChord.delete(id)) { if (!this.xChord.size && !this.xDown.size) this.chordActive = false; return true; }
    if (this.xTimers.has(id)) { // a quick click: replay press and release together
      clearTimeout(this.xTimers.get(id)); this.xTimers.delete(id);
      if (!this.xHandle(id)) { native.winCursor.xbutton(which, true); native.winCursor.xbutton(which, false); }
      return true;
    }
    if (this.xReplayed.delete(id)) return false; // the system saw the replayed press, so it gets the real release
    return false;
  }

  // Windows mouse hook. Returns true to swallow the event.
  onWinMouse(msg, i) {
    this.inHook = true;
    try { return this.onWinMouseInner(msg, i); } catch (e) { this.dc('error'); this.d('error', { where: 'hook', msg: String(e && e.message) }); return false; } finally { this.inHook = false; }
  }

  // SetCursorPos makes the system run the mouse hook once more (as an "injected" move) on this very thread. Called from inside the hook
  // callback it can leave the system and this thread waiting for each other, so from there it is postponed until the callback has returned.
  placeCursor(x, y) {
    if (this.inHook) { setImmediate(() => this.input.setPos(x, y)); return; }
    this.input.setPos(x, y);
  }

  onWinMouseInner(msg, i) {
    // ISLAND_TEST_INJECTED lets automated tests stand in for a physical mouse
    const injected = (i.flags & 1) !== 0 && !process.env.ISLAND_TEST_INJECTED;
    if (!injected && this.pickerClick(msg === 0x201 ? 'ldown' : msg === 0x202 ? 'lup' : msg === 0x204 ? 'rdown' : msg === 0x205 ? 'rup' : '')) return true;
    if (!injected) {
      // Never swallow only half of a press: the system tracks button state, so a swallowed release
      // without a swallowed press (or the other way round) leaves a button stuck down.
      const b = BTN[msg];
      if (b && b[0] === 'M' && b[1] === 'down' && this.state === 'idle') { // wheel press on this computer
        const a = this.buttonMap.middle;
        if (a && a !== 'default') { this.swallowedBtn.add('M'); this.runAction(a, 'middle', 0); return true; }
      }
      if (b) {
        if (b[1] === 'up') { if (this.swallowedBtn.delete(b[0])) { if (b[0] === 'M') this.emit('middle-up'); return true; } }
        else if (this.state === 'controlling' && this.external) { this.swallowedBtn.add(b[0]); return true; }
      }
      if (msg === 0x20B || msg === 0x20C) return this.onXButton(msg, i);
    }
    if (this.state === 'idle' && !injected && msg === 0x200) this.trackPush(i.x, i.y);
    if (this.state === 'idle' && this.owner === 'peer' && !injected && msg === 0x200 && this.sock && this.peer && Date.now() >= this.cooldownUntil && !this.inFreelook()) {
      if (this.beginAttach()) return true;
    }
    if (this.state === 'controlled') {
      if (!injected && msg === 0x200) {
        // SetCursorPos (how this computer is steered) shows up in the hook as a normal move at the very place we put the
        // cursor; only movement that is somewhere else is the user's own mouse, and it has to repeat to count
        const ours = this.recent.some((p) => Math.abs(p.x - i.x) <= 3 && Math.abs(p.y - i.y) <= 3);
        if (ours) this.hookMismatch = 0;
        else if (++this.hookMismatch >= 2) { this.hookMismatch = 0; this.physicalTakeback('hook', i.x, i.y); }
      }
      return false;
    }
    if (msg === 0x20E && !injected && this.state === 'idle') { // thumb wheel / tilt wheel on this computer
      const d = (i.mouseData >>> 16) << 16 >> 16;
      if (d && this.runAction(this.buttonMap[d > 0 ? 'tiltRight' : 'tiltLeft'], d > 0 ? 'tiltRight' : 'tiltLeft')) return true;
    }
    if (msg === 0x20A && !injected && this.state !== 'controlling' && this.prefs.smoothWheel && this.external) {
      const delta = (i.mouseData >>> 16) << 16 >> 16;
      const held = native.winModsHeld(); // Ctrl+wheel zooms, Shift+wheel goes sideways: those must reach the application untouched
      if (delta && delta % 120 === 0 && !held) { this.localSmooth.add(0, -delta / 120); this.dc('scroll.smooth'); return true; }
    }
    if (this.state !== 'controlling' || !this.external || injected) return false;
    if (msg === 0x20A || msg === 0x20E) { // wheel: exact smooth deltas straight from the system (120 per notch)
      const delta = (i.mouseData >>> 16) << 16 >> 16;
      const notch = delta % 120 === 0; // a wheel with clicks (smooth devices send fractions of a notch)
      if (msg === 0x20A) this.queueScroll(0, (-delta / 120) * 100, notch); else this.queueScroll((delta / 120) * 100, 0, notch);
      return true;
    }
    if (msg !== 0x200) return false; // releases of buttons pressed before the capture must reach the system
    if (Date.now() < this.parkUntil) return true;
    // the cursor is frozen at the anchor, so the position the system reports is anchor + this event's movement
    const dx = i.x - this.anchor.x, dy = i.y - this.anchor.y;
    if (Math.abs(dx) > 400 || Math.abs(dy) > 400) {
      if (++this.farMoves > 5) { this.farMoves = 0; this.placeCursor(this.anchor.x, this.anchor.y); this.parkUntil = Date.now() + 25; }
      return true;
    }
    this.farMoves = 0;
    if (dx || dy) this.queueMove(dx, dy);
    return true;
  }

  // one line in the run log per finished wheel glide: proves the tuning (step / speed / duration) is what is being applied
  glideLog(who, g) {
    this.dc('glide.' + who);
    this.glides = (this.glides || 0) + 1;
    if (this.glides <= 300) { try { const ss = this.scrollSettings; require('./lifecycle').line(`wheel glide (${who}): ${g.notches} notch -> ${g.sent} px (glide) x scroll speed ${Math.round(ss.speed * 100)}%${ss.reverse ? ', reversed' : ''} in ${g.ms} ms, ${g.steps} steps | tuning step ${g.tune.step} px, speed ${g.tune.speed}x, duration ${g.tune.duration} ms`); } catch {} }
  }

  // A mapped trigger (thumb wheel tilt, side buttons) on the computer that is being operated. Returns true when it was handled
  // here (so the original event must not act as well).
  runAction(action, trigger, limitMs = 450) {
    if (!action || action === 'default') return false;
    if (action === 'none') return true;
    const now = Date.now();
    if (limitMs && now - (this.lastAct[trigger] || 0) < limitMs) return true; // one gesture = one action
    this.lastAct[trigger] = now;
    this.dc('action.' + action);
    try { require('./lifecycle').line(`action ${action} (trigger ${trigger})`); } catch {}
    if (action === 'pickColor') { this.emit('pick-color'); return true; }
    if (action === 'radial') { this.emit('radial', trigger); return true; }
    if (action === 'screenshot') this.markShot();
    if (HK.isKeysAction(action)) return this.pressCombo(action.slice(5));
    if (process.platform === 'darwin') { // the system's own shortcut (whatever is configured in System Settings), key chord as a fallback
      const hot = { desktopLeft: 'spaceLeft', desktopRight: 'spaceRight', missionControl: 'missionControl' }[action];
      if (hot && native.macPostHotKey(hot)) return true;
    }
    const combo = ACTIONS[action] && ACTIONS[action][process.platform];
    if (!combo) return true;
    const plat = process.platform, [mods, k] = combo;
    for (const m of mods) this.input.key(m, true, plat);
    this.input.key(k, true, plat); this.input.key(k, false, plat);
    for (const m of [...mods].reverse()) this.input.key(m, false, plat);
    return true;
  }

  // side button pressed on a physical mouse: forwarded while controlling, otherwise a mapped action replaces it
  xHandle(id) {
    const trig = id === 4 ? 'back' : 'forward';
    if (this.state === 'controlling' && this.external) { this.send({ t: 'xbtn', k: trig }); return true; }
    if (this.state === 'idle') { const a = this.buttonMap[trig]; if (a && a !== 'default') return this.runAction(a, trig, 0); }
    return false;
  }

  // While the color picker is live a click belongs to it: the left button picks, the right button cancels. Returns true to swallow.
  pickerClick(kind) {
    if (!kind) return false;
    if (this.picker) {
      if (kind === 'ldown') { this.pickEatUp = Date.now() + 1500; this.picker.pick(); return true; }
      if (kind === 'rdown') { this.pickEatUp = Date.now() + 1500; this.picker.cancel(); return true; }
      return true; // the matching releases
    }
    if ((kind === 'lup' || kind === 'rup') && Date.now() < (this.pickEatUp || 0)) { this.pickEatUp = 0; return true; }
    return false;
  }

  // movement is batched (about 200 messages a second instead of one per hardware event)
  queueMove(dx, dy) {
    this.pendX += dx; this.pendY += dy;
    const wait = 6 - (Date.now() - this.lastFlush);
    if (wait <= 0) this.flushMove();
    else if (!this.pendTimer) this.pendTimer = setTimeout(() => this.flushMove(), wait);
  }

  flushMove() {
    if (this.pendTimer) { clearTimeout(this.pendTimer); this.pendTimer = null; }
    this.lastFlush = Date.now();
    const dx = this.pendX, dy = this.pendY;
    this.pendX = this.pendY = 0;
    if ((dx || dy) && this.state === 'controlling') { this.send({ t: 'move', dx, dy }); this.dc('moves.tx'); }
  }

  // scrolling is sent in pixels (positive = down / right) and batched like movement
  queueScroll(x, y, discrete = false) {
    this.scrollX += x; this.scrollY += y;
    if (discrete) this.scrollDiscrete = true;
    if (!this.scrollTimer) this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const sx = this.scrollX, sy = this.scrollY, n = this.scrollDiscrete ? 1 : 0;
      this.scrollX = this.scrollY = 0; this.scrollDiscrete = false;
      if ((sx || sy) && this.state === 'controlling') { this.send({ t: 'scroll', x: sx, y: sy, n }); this.dc('scroll.tx'); }
    }, 8);
  }

  // macOS event tap: exact pixel scrolling (down / right positive). While controlling it is forwarded and swallowed.
  onMacScroll(x, y, info = {}) {
    // events this app posted itself (marker, or posted a moment ago, or while this computer is being steered) pass untouched
    if (info.click) return this.pickerClick(info.click);
    if (info.mid) { // the wheel was pressed (mid 1) or released (mid 2) on a mouse connected to this Mac
      const a = this.buttonMap.middle;
      if (info.mid === 1 && this.state === 'idle' && a && a !== 'default') { this.midSwallowed = true; this.runAction(a, 'middle', 0); return true; }
      if (info.mid === 2 && this.midSwallowed) { this.midSwallowed = false; this.emit('middle-up'); return true; }
      return false;
    }
    if (info.disabled) { this.dc('scroll.tapoff'); return false; } // the system switched the tap off for a moment (too slow)
    if (!info.continuous) this.dc('scroll.wheel'); else this.dc('scroll.pad');
    if (info.ours || this.state === 'controlled' || Date.now() - (this.injectAt || 0) < 60) return false;
    if (this.state === 'controlling') {
      this.lastOverlayWheel = Date.now();
      // a wheel with clicks is sent as whole notches (100 px each) so the other computer can tune it to its own taste
      if (!info.continuous && (info.lx || info.ly)) this.queueScroll((info.lx || 0) * 100, (info.ly || 0) * 100, true);
      else this.queueScroll(x, y, !info.continuous);
      return true;
    }
    if (!info.continuous && info.lx && !info.ly) { // thumb wheel on a mouse connected to this Mac
      const t = info.lx > 0 ? 'tiltRight' : 'tiltLeft';
      if (this.runAction(this.buttonMap[t], t)) return true;
    }
    // this computer's own mouse wheel (not a trackpad, not with Shift/Ctrl/Option/Cmd held). On the Mac the system already glides the
    // wheel smoothly, so the real event is only scaled (step, speed, scroll speed, reverse): re-posting our own glide felt choppy.
    if (!x && !y && !info.lx && !info.ly) return false; // an event without movement (a phase marker): leave it alone
    if (this.prefs.smoothWheel && !info.continuous && !(info.flags & 0x001e0000)) {
      const t = this.scrollTune, ss = this.scrollSettings, now = Date.now();
      this.macStreak = now - (this.macLast || 0) < 220 ? (this.macStreak || 0) + 1 : 1;
      this.macLast = now;
      const gain = 1 + (t.speed - 1) * Math.min(this.macStreak - 1, 5) / 5; // quick notches in a row scroll further
      const f = (t.step / 90) * gain * ss.speed * (ss.reverse ? -1 : 1);
      this.dc('scroll.scaled');
      if (now - (this.macLogAt || 0) > 400 && (this.macLogs = (this.macLogs || 0) + 1) <= 300) { this.macLogAt = now; try { require('./lifecycle').line(`wheel scaled (native): x${Math.abs(f).toFixed(2)}${f < 0 ? ' reversed' : ''} = step ${t.step}/90 x acceleration ${gain.toFixed(2)} x scroll speed ${Math.round(ss.speed * 100)}%`); } catch {} }
      return Math.abs(f - 1) < 0.01 ? false : f;
    }
    return false;
  }

  // the Mac overlay sees precise trackpad deltas when the tap is unavailable
  onOverlayWheel(dx, dy, mode) {
    if (this.state !== 'controlling') return;
    const unit = mode === 1 ? 16 : mode === 2 ? 800 : 1;
    this.lastOverlayWheel = Date.now();
    this.queueScroll(dx * unit, dy * unit);
  }

  // remember where we put the cursor so our own injected movement isn't mistaken for the user's hand
  placed(x, y) {
    const now = Date.now();
    this.recent = this.recent.filter((p) => now - p.t < 500);
    this.recent.push({ x, y, t: now });
  }

  onLocalMove(x, y) {
    if (this.state !== 'controlled') this.physicalAt = Date.now();
    if (this.state === 'idle') this.lastHandMoveAt = Date.now();
    try { this.onLocalMoveInner(x, y); } catch (e) { this.dc('error'); this.d('error', { where: 'move', msg: String(e && e.message) }); }
  }

  onLocalMoveInner(x, y) {
    if (!this.sock || !this.peer) return;
    if (this.state === 'controlled') {
      if (this.external) return; // the native hook tells real mouse movement from injected movement exactly
      const hid = this.input.physicalMouse && this.input.physicalMouse(); // macOS: hardware-only activity clock
      if (hid === true) return this.physicalTakeback('hardware', x, y);
      if (hid === false) { this.mismatch = 0; return; }
      // otherwise: movement that doesn't match anything we placed is the user's own hand (needs a few in a row)
      if (this.recent.some((p) => Math.abs(p.x - x) <= 4 && Math.abs(p.y - y) <= 4)) { this.mismatch = 0; return; }
      if (++this.mismatch >= 3) this.physicalTakeback('heuristic', x, y);
      return;
    }
    if (this.state === 'idle') {
      if (Date.now() < this.cooldownUntil) return;
      if (this.owner === 'peer') { // my mouse moved while the pointer is over there: drive it from here
        if (this.inFreelook()) return;
        const far = !this.lastIdle || Date.now() - this.lastIdle.t > 600 || Math.hypot(x - this.lastIdle.x, y - this.lastIdle.y) > 4;
        if (!this.lastIdle || Date.now() - this.lastIdle.t > 600) this.lastIdle = { x, y, t: Date.now() };
        else if (far) this.beginAttach();
        return;
      }
      if (this.owner === null) { this.owner = 'me'; this.send({ t: 'owner', mine: true }); }
      if (this.inFreelook()) return;
      const c = L.crossing(this.myDisplays, this.myOff(), this.peer.displays, this.peerOff(), x, y);
      if (!this.pushAllowed(c)) return;
      this.d('cross', { dir: c.dir, at: { x: Math.round(x), y: Math.round(y) }, push: Math.round(this.pushDist), need: this.prefs.edgeResistance });
      this.pushDist = 0; this.edgeEvents = 0;
      const d = L.dispAt(this.myDisplays, x, y);
      // freeze the cursor a little inside the edge it left through (not in the middle of the screen)
      const [avx, avy] = L.VEC[c.dir];
      this.anchor = {
        x: Math.min(d.x + d.w - 2, Math.max(d.x + 1, x - avx * 150)),
        y: Math.min(d.y + d.h - 2, Math.max(d.y + 1, y - avy * 150)),
      };
      this.last = { ...this.anchor };
      this.state = 'controlling';
      this.parkUntil = Date.now() + 25;
      this.farMoves = 0;
      this.send({ t: 'enter', x: c.h.x, y: c.h.y, dir: c.dir, mpp: d.mpp });
      this.placeCursor(this.anchor.x, this.anchor.y);
      this.notify();
    } else if (this.state === 'controlling') {
      if (this.external) return;
      if (this.locked) {
        // pointer lock engaged but the cursor still moves and no deltas arrive: the lock is useless, fall back
        if (Date.now() > this.relIgnoreUntil + 400 && ++this.hookMovesLocked > 40 && this.relMoves === 0) { this.locked = false; this.emit('lockfail'); }
        return;
      }
      // right after crossing, ignore the stale events from before the cursor was parked (they caused a big jump)
      if (this.awaitAnchor) {
        const near = Math.abs(x - this.anchor.x) <= 3 && Math.abs(y - this.anchor.y) <= 3;
        if (near || Date.now() > this.awaitAnchor) { this.awaitAnchor = 0; this.last = { x, y }; }
        return;
      }
      const dx = x - this.last.x, dy = y - this.last.y;
      this.last = { x, y };
      if (dx || dy) this.queueMove(dx, dy);
      if (Math.abs(x - this.anchor.x) > DRIFT || Math.abs(y - this.anchor.y) > DRIFT) {
        this.last = { ...this.anchor };
        this.placeCursor(this.anchor.x, this.anchor.y);
      }
    }
  }

  // diagnostics (all optional and never allowed to break anything)
  d(type, data) { if (this.diag) this.diag.event(type, data); }
  dc(name, n) { if (this.diag) this.diag.count(name, n); }
  ds(name, v) { if (this.diag) this.diag.stat(name, v); }

  // after placing the pointer, read back where it really is and measure the error (pixels, and millimetres on the layout)
  verifyLanding(kind, target, plane) {
    if (!this.diag) return;
    setTimeout(() => {
      try {
        const actual = this.input.getPos && this.input.getPos();
        if (!actual) return;
        const err = Math.hypot(actual.x - target.x, actual.y - target.y);
        const d = L.dispAt(this.myDisplays, actual.x, actual.y);
        let errMm = null;
        if (d && plane) { const p = L.toPlane(d, this.myOff(), actual.x, actual.y); errMm = Math.hypot(p.x - plane.x, p.y - plane.y); }
        this.ds('entryErrPx', err);
        if (errMm !== null) this.ds('entryErrMm', errMm);
        this.d(kind, { target: { x: Math.round(target.x), y: Math.round(target.y) }, actual: { x: Math.round(actual.x), y: Math.round(actual.y) }, errPx: Math.round(err * 10) / 10, errMm: errMm === null ? null : Math.round(errMm * 10) / 10 });
      } catch { /* ignore */ }
    }, 40);
  }

  // A game (hidden or confined cursor) is in charge of the pointer: never take it over or cross while that lasts.
  inFreelook() {
    if (!this.prefs.freelookGuard || !this.input.freelook) return false;
    const now = Date.now();
    if (now - this.freelookAt > 80) {
      this.freelookAt = now;
      this.freelookVal = this.input.freelook() || '';
      if (this.freelookVal && this.freelookVal !== this.freelookWhy) { this.freelookWhy = this.freelookVal; try { require('./lifecycle').line('game guard: holding back because ' + (this.freelookVal === 'confined' ? 'the pointer is confined to a smaller area' : this.freelookVal === 'hidden-fullscreen' ? 'a full-screen app hides the pointer' : 'a game controls the pointer')); } catch {} }
    }
    if (this.freelookVal) this.dc('block.freelook');
    return !!this.freelookVal;
  }

  // Edge resistance: the pointer has to keep pushing against the edge a little before it crosses, and it
  // does not cross at all while a button is held (dragging a window to the edge, selecting text, ...).
  pushAllowed(crossing) {
    if (!crossing) { this.edgeEvents = 0; return false; }
    if (this.buttonsDown.size) { this.dc('block.drag'); return false; }
    const r = this.prefs.edgeResistance;
    if (r <= 0) return true;
    const ok = this.external ? this.pushDist >= r : ++this.edgeEvents >= Math.max(2, Math.ceil(r / 8)); // Windows: distance pushed past the edge; elsewhere: events pinned at it
    if (!ok) this.dc('block.resist');
    return ok;
  }

  // Windows hook: how far the pointer is being pushed beyond the screen edge (the hook sees the unclamped position)
  trackPush(x, y) {
    const d = L.dispAt(this.myDisplays, Math.min(Math.max(x, -1e9), 1e9), y) || L.clampToDisplays(this.myDisplays, x, y).d;
    if (!d) return;
    const over = Math.max(0, x - (d.x + d.w - 1), d.x - x, y - (d.y + d.h - 1), d.y - y);
    if (over > 0) this.pushDist += over;
    else if (x > d.x + 3 && x < d.x + d.w - 4 && y > d.y + 3 && y < d.y + d.h - 4) this.pushDist = 0; // moved away from the edge
  }

  // Take over the pointer that is on the other computer, without moving it: it simply keeps going from its last place.
  beginAttach() {
    if (this.state !== 'idle' || !this.sock || !this.peer) return false;
    const cur = (this.input.getPos && this.input.getPos()) || this.lastIdle || { x: 0, y: 0 };
    const d = L.dispAt(this.myDisplays, cur.x, cur.y) || this.myDisplays[0];
    if (!d) return false;
    const room = (v, lo, size) => (size > 400 ? Math.min(lo + size - 150, Math.max(lo + 150, v)) : lo + size / 2);
    this.anchor = { x: room(cur.x, d.x, d.w), y: room(cur.y, d.y, d.h) };
    this.last = { ...this.anchor };
    this.lastIdle = null;
    this.state = 'controlling';
    this.parkUntil = Date.now() + 25;
    this.farMoves = 0;
    this.send({ t: 'attach', mpp: d.mpp });
    this.placeCursor(this.anchor.x, this.anchor.y);
    this.notify();
    return true;
  }

  // "Look to switch": hand the pointer to the other computer without crossing an edge.
  // It lands where it last was on that computer, or in the middle of its main screen.
  // true while the user is typing (a key is held, or one was touched a moment ago): gaze must not move keystrokes to the other computer
  typingBusy() { return !!(this.mods && this.mods.size) || Date.now() - (this.lastKeyAt || 0) < 1000; }
  // true while the mouse is being used by hand (moved a moment ago, or a button is held): the head must not take it away then
  mouseBusy() { return Date.now() - (this.lastHandMoveAt || 0) < 350 || this.buttonsDown.size > 0; }

  gazeEnter() {
    if (!this.sock || !this.peer) return false;
    // the other computer is steering this one and the user now looks at the other computer: hand the pointer back to it
    // (same message as when the user grabs the local mouse, so the other computer needs no camera and no protocol change)
    if (this.state === 'controlled') {
      if (this.typingBusy()) return 'busy';
      const cur = (this.input.getPos && this.input.getPos()) || this.last;
      this.physicalTakeback('gaze', cur.x, cur.y);
      return true;
    }
    if (this.state !== 'idle' || !this.peer.displays.length) return false;
    if (this.typingBusy()) return 'busy';
    if (this.mouseBusy()) return 'busy';
    const cur = (this.input.getPos && this.input.getPos()) || this.last;
    const d = L.dispAt(this.myDisplays, cur.x, cur.y) || this.myDisplays[0];
    if (!d) return false;
    let h = this.lastPeerPlane;
    const known = h && this.peer.displays.some((o) => L.planeRect(o, this.peerOff()).x <= h.x && h.x < L.planeRect(o, this.peerOff()).x + o.dw && L.planeRect(o, this.peerOff()).y <= h.y && h.y < L.planeRect(o, this.peerOff()).y + o.dh);
    if (!known) {
      const o = this.peer.displays.find((x) => x.dx === 0 && x.dy === 0) || this.peer.displays[0];
      h = L.toPlane(o, this.peerOff(), o.x + o.w / 2, o.y + o.h / 2);
    }
    this.anchor = { x: Math.min(d.x + d.w - 2, Math.max(d.x + 1, cur.x)), y: Math.min(d.y + d.h - 2, Math.max(d.y + 1, cur.y)) };
    this.last = { ...this.anchor };
    this.state = 'controlling';
    this.parkUntil = Date.now() + 25;
    this.farMoves = 0;
    this.send({ t: 'enter', x: h.x, y: h.y, dir: this.status().peerSide, mpp: d.mpp });
    this.placeCursor(this.anchor.x, this.anchor.y);
    this.notify();
    return true;
  }

  // Self test of the keyboard path: take control of the other computer, press a harmless key (F24) on it, give control back.
  // The other computer logs that its own input hook saw the key, which proves the key really went through the system.
  async injectTest(keys = ['F24'], click = true) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ok = this.gazeEnter();
    if (ok !== true) return 'could not take control: ' + ok;
    await sleep(400);
    for (const k of keys) { // "Ctrl+Alt+J" = a chord: the modifiers stay down while the key is pressed
      const parts = k.split('+'), key = parts.pop();
      for (const m of parts) this.onLocalKey(true, m);
      this.onLocalKey(true, key); await sleep(60); this.onLocalKey(false, key);
      for (const m of parts.reverse()) this.onLocalKey(false, m);
      await sleep(60);
    }
    if (click) { this.send({ t: 'down', b: 3, n: 1 }); await sleep(120); this.send({ t: 'up', b: 3 }); } // middle button: opens the wheel menu on the other computer
    await sleep(1300); // gazeLeave refuses while keys were just typed
    const left = this.gazeLeave();
    return 'sent ' + keys.join(',') + (click ? ' and a middle click' : '') + ' to the other computer; leaving: ' + left;
  }

  gazeLeave() {
    if (this.state !== 'controlling') return false;
    if (this.typingBusy()) return 'busy';
    this.forceRelease();
    return true;
  }

  // One step of pointer movement on the computer being controlled.
  applyMove(dx, dy) {
    if (this.state !== 'controlled' || !this.peer) return;
    // the other computer's pixels and ours differ in size: move the same distance on the screen
    const here = L.dispAt(this.myDisplays, this.virt.x, this.virt.y);
    if (this.ctrlMpp && here && here.mpp) { const k = Math.min(3, Math.max(0.33, this.ctrlMpp / here.mpp)); dx *= k; dy *= k; }
    let bx = this.virt.x, by = this.virt.y;
    const cur = this.input.getPos && this.input.getPos();
    // if the system put the cursor somewhere else than we asked (wall, notch, Dock...), keep going from where it really is
    if (cur && this.lastSet && (Math.abs(cur.x - this.lastSet.x) > 2 || Math.abs(cur.y - this.lastSet.y) > 2) && L.dispAt(this.myDisplays, cur.x, cur.y)) { bx = cur.x; by = cur.y; this.dc('feedback'); }
    const nx = bx + dx, ny = by + dy;
    if (L.dispAt(this.myDisplays, nx, ny)) {
      this.virt = { x: nx, y: ny };
    } else {
      // off every screen: either the way back to the other computer, or a wall
      const cl = L.clampToDisplays(this.myDisplays, nx, ny);
      if (!cl) return;
      const c = L.crossing(this.myDisplays, this.myOff(), this.peer.displays, this.peerOff(), cl.x, cl.y, { dx: dx, dy: dy });
      if (c) {
        this.state = 'idle';
        this.owner = 'peer';
        this.d('leave', { dir: c.dir, from: { x: Math.round(cl.x), y: Math.round(cl.y) } });
        this.send({ t: 'leave', x: c.h.x, y: c.h.y, dir: c.dir });
        this.notify();
        return;
      }
      this.virt = { x: cl.x, y: cl.y };
      this.dc('wall');
    }
    this.placed(this.virt.x, this.virt.y);
    this.lastSet = { x: Math.round(this.virt.x), y: Math.round(this.virt.y) };
    this.placeCursor(this.virt.x, this.virt.y);

  }

  // Movement arrives in bursts when the network jitters. Play it out at a steady rate instead of jumping:
  // each 4 ms tick applies a share of what is waiting, so a burst glides in over a few frames.
  smoothTick() {
    if (this.state !== 'controlled') { this.inX = this.inY = 0; clearInterval(this.smoothTimer); this.smoothTimer = null; return; }
    const take = (v) => (Math.abs(v) < 1.5 ? v : v * 0.4);
    this.ds('smoothQueue', Math.abs(this.inX) + Math.abs(this.inY));
    const dx = take(this.inX), dy = take(this.inY);
    this.inX -= dx; this.inY -= dy;
    if (dx || dy) this.applyMove(dx, dy);
    if (Math.abs(this.inX) < 0.01 && Math.abs(this.inY) < 0.01) { this.inX = this.inY = 0; clearInterval(this.smoothTimer); this.smoothTimer = null; }
  }

  // anything that must happen at the pointer's real position first gets the waiting movement
  drainMoves() {
    const dx = this.inX, dy = this.inY;
    this.inX = this.inY = 0;
    if (dx || dy) this.applyMove(dx, dy);
  }

  // Emergency exit (Ctrl+Alt+Shift+Q): give the pointer back to this computer
  emitSwitch(to, prev) {
    let edge = this.peerSide;
    try { const st = this.status(); if (st && st.peerSide) edge = st.peerSide; } catch {}
    this.emit('switch', { to, prev, edge }); // edge: the side the other computer is on, which is where the pointer comes from
  }

  // Emergency exit (global shortcut): give mouse, buttons and keys back to this computer whatever state things are in.
  panic() {
    this.dc('panic');
    this.swallowedBtn.clear(); this.xDown.clear(); this.xChord.clear(); this.xSent.clear(); this.xReplayed.clear();
    for (const t of this.xTimers.values()) clearTimeout(t);
    this.xTimers.clear();
    this.midSwallowed = false; this.midRemote = false; this.chordActive = false; this.sideHeld.clear();
    try { this.localSmooth.flush(); this.remoteSmooth.flush(); } catch {}
    if (this.state === 'controlling') this.forceRelease();
    else if (this.state === 'controlled') this.physicalTakeback('panic', 0, 0);
    this.cooldownUntil = Date.now() + 1500; // do not jump back at once
    try { this.input.releaseAll(); this.input.releaseLocalModifiers(); } catch {}
    this.notify();
  }

  // Windows ignores injected input aimed at an app that runs as administrator: tell the person instead of leaving them wondering.
  checkElevated() {
    if (process.platform !== 'win32' || !native.winCursor.foregroundElevated) return;
    const now = Date.now();
    if (now - (this.elevCheckAt || 0) < 700) return;
    this.elevCheckAt = now;
    if (native.winCursor.foregroundElevated() !== true || now - (this.elevWarnAt || 0) < 20000) return;
    this.elevWarnAt = now;
    const text = 'Windows does not let A-tuls click or type in an app that runs as administrator (like Task Manager). Close that app, or run A-tuls as administrator.';
    try { require('./lifecycle').line('input blocked: the window in front runs as administrator'); } catch {}
    this.emit('notice', { title: 'Cannot control this app', text: 'Run it as administrator, or close it', kind: 'err' }); // the same message the other computer shows for its own events
    this.send({ t: 'notice', title: 'Cannot control this app', text: 'Run A-tuls as administrator, or close it', kind: 'err' });
  }

  // ---- screenshots -----------------------------------------------------------
  // A screenshot taken here (by a mapped button, by the other computer's request, or by the system shortcut) ends up on the clipboard a few
  // moments later; for a while after it, a new clipboard image counts as a screenshot and main.js can save it to the chosen folder.
  markShot() { this.shotUntil = Date.now() + 45000; }
  shoot() { this.markShot(); this.input.screenshot(); }

  // ---- keyboard shortcuts -------------------------------------------------------
  matchHotkey(heldNames, key) {
    const combo = HK.comboOf(heldNames, key);
    return this.hotkeys.find((h) => h.combo === combo) || null;
  }

  // Keys typed on the other computer while it controls this one: its shortcuts are looked up here, and the key that completes one is not
  // injected (the modifiers already were, which is harmless).
  remoteHotkey(m) {
    if (HK.isMod(m.c)) { if (m.d) this.rMods.add(m.c); else this.rMods.delete(m.c); return false; }
    if (!m.d) return this.hotSwallow.delete(m.c);
    if (!this.hotkeys.length) return false;
    const hit = this.matchHotkey(this.rMods, m.c);
    if (!hit) return false;
    this.hotSwallow.add(m.c);
    this.runAction(hit.action, 'hotkey:' + hit.combo, 400);
    return true;
  }

  // press a recorded combination on this computer (the one being operated)
  pressCombo(text) {
    const c = HK.parseCombo(text, null);
    if (!c) return true;
    const plat = process.platform;
    this.injecting = Date.now() + 400; // our own injected keys must not trigger shortcuts again
    for (const m of c.mods) this.input.key(m, true, plat);
    this.input.key(c.key, true, plat); this.input.key(c.key, false, plat);
    for (const m of [...c.mods].reverse()) this.input.key(m, false, plat);
    return true;
  }

  // Record the next key combination typed on this computer's keyboard (for the settings window). cb(combo) or cb(null) when cancelled.
  startRecording(cb, ms = 15000) {
    this.stopRecording(null);
    const rec = { cb, held: new Set(), timer: setTimeout(() => this.stopRecording(null), ms) };
    if (rec.timer.unref) rec.timer.unref();
    this.recorder = rec;
  }
  stopRecording(combo) {
    const r = this.recorder;
    if (!r) return;
    this.recorder = null;
    clearTimeout(r.timer);
    try { r.cb(combo); } catch {}
  }
  // returns true: the key belongs to the recorder
  recordKey(down, code) {
    const r = this.recorder;
    if (!r) return false;
    if (HK.isMod(code)) { if (down) r.held.add(code); else r.held.delete(code); return true; }
    if (!down) return true;
    if (code === 'Escape' && !r.held.size) { this.stopRecording(null); return true; }
    if (!r.held.size && HK.needsModifier(code)) return true; // a plain letter is not a shortcut: keep waiting
    this.stopRecording(HK.comboOf(r.held, code));
    return true;
  }

    forceRelease() {
    if (this.state !== 'controlling') return;
    this.state = 'idle';
    this.owner = 'me';
    this.cooldownUntil = Date.now() + 150;
    this.send({ t: 'release' });
    this.placeCursor(this.anchor.x, this.anchor.y);
    this.notify();
  }

  onRelMove(dx, dy) {
    // engaging the pointer lock recentres the cursor, which shows up as one big fake movement: skip the first moments
    if (Date.now() < this.relIgnoreUntil && (Math.abs(dx) > 100 || Math.abs(dy) > 100)) return;
    this.relMoves++;
    if (this.state === 'controlling' && (dx || dy)) this.queueMove(dx, dy);
  }

  // fallback for when the global hook delivers no keys (e.g. Input Monitoring missing): the focused overlay sees them
  onOverlayKey(down, domCode) {
    if (Date.now() - this.lastHookKey < 250) return;
    const name = DOM_NAMES[domCode] || String(domCode).replace(/^(Key|Digit)/, '');
    this.onLocalKey(down, name);
  }

  onLocalKey(down, code) {
    if (this.state !== 'controlled') this.physicalAt = Date.now();
    if (this.recorder && this.recordKey(down, code)) return;
    const mods = this.mods || (this.mods = new Set());
    if (down) mods.add(code); else mods.delete(code);
    this.lastKeyAt = Date.now();
    if (down && this.state === 'idle') { // the system's own screenshot shortcut typed on this keyboard (Mac: only the ones that go to the clipboard)
      const m = this.mods, held = (a, b) => m.has(a) || m.has(b);
      if (process.platform === 'win32' && code === 'S' && held('Meta', 'MetaRight') && held('Shift', 'ShiftRight')) this.markShot();
      else if (process.platform === 'darwin' && ['3', '4', '5'].includes(code) && held('Meta', 'MetaRight') && held('Shift', 'ShiftRight')) this.markShot();
    }
    if (down && this.state === 'idle' && this.hotkeys.length && Date.now() > this.injecting && !HK.isMod(code)) {
      const hit = this.matchHotkey(mods, code);
      if (hit) { this.runAction(hit.action, 'hotkey:' + hit.combo, 400); return; }
    }
    if (this.state !== 'controlling') return;
    const has = (a, b) => mods.has(a) || mods.has(b);
    // Win+Shift+S while controlling a Mac = Mac region screenshot (lands in the clipboard, which syncs back)
    if (down && code === 'S' && this.peerPlat === 'darwin' && process.platform === 'win32' && has('Meta', 'MetaRight') && has('Shift', 'ShiftRight')) { this.send({ t: 'shot' }); return; }
    // Cmd+Shift+4 / 5 on the Mac while controlling a PC = Windows snipping (Win+Shift+S); the Mac's own screenshot UI is dismissed
    if (down && (code === '4' || code === '5') && this.peerPlat === 'win32' && process.platform === 'darwin' && has('Meta', 'MetaRight') && has('Shift', 'ShiftRight')) { this.send({ t: 'shot' }); this.emit('suppress-shot'); return; }
    if (down && code === 'Q' && has('Ctrl', 'CtrlRight') && has('Alt', 'AltRight') && has('Shift', 'ShiftRight')) return this.forceRelease();
    if (this.keyLog === undefined) this.keyLog = 0;
    if (this.keyLog++ < 8) console.log('[island] key ->', code, down ? 'down' : 'up');
    this.send({ t: 'key', d: down, c: code });
  }
  // Both side buttons of the mouse (back + forward) together = region screenshot to the clipboard,
  // taken on whichever computer the pointer is on; the clipboard sync brings it to the other one.
  sideChord(down, button) {
    if (down) {
      this.sideHeld.add(button);
      if (this.sideHeld.has(4) && this.sideHeld.has(5) && !this.chordActive) {
        this.chordActive = true;
        const a = this.buttonMap.chord;
        console.log('[island] back+forward chord ->', this.state === 'controlling' ? 'the other computer' : 'this computer', a || 'default');
        if (this.state === 'controlling') this.send({ t: 'xbtn', k: 'chord' });
        else if (this.state === 'idle') { if (!this.runAction(a, 'chord', 0)) this.shoot(); }
      }
    } else {
      this.sideHeld.delete(button);
      if (!this.sideHeld.size && !this.external) this.chordActive = false;
    }
  }

  onLocalButton(down, button, clicks = 1) {
    if (this.state !== 'controlled') this.physicalAt = Date.now();
    if (button === 4 || button === 5) this.sideChord(down, button);
    else if (down) this.buttonsDown.add(button);
    else this.buttonsDown.delete(button);
    if (this.state === 'controlling' && Date.now() >= this.ignoreButtonsUntil) this.send({ t: down ? 'down' : 'up', b: button, n: clicks }); }
  // rotation 0 is a partial notch from a smooth-scrolling device: nothing to forward (it used to scroll up by accident)
  onLocalWheel(direction, rotation) {
    // the Windows hook and the Mac overlay deliver scrolling themselves; this is only the fallback
    if (this.state !== 'controlling' || !rotation || this.external || Date.now() - this.lastOverlayWheel < 1500) return;
    if (direction === 3) this.queueScroll(0, rotation * 60); else this.queueScroll(rotation * 60, 0);
  }

  // ---- messages from the peer ------------------------------------------
  // Both computers can end up thinking they are the one in control (each took over at the same moment). The one with
  // the lower device id keeps control and ignores the other's request; the other gives way.
  iWinConflict() { return !this.peer || this.id < this.peer.id; }

  onMessage(m) {
    this.lastRx = Date.now();
    try { this.onMessageInner(m); } catch (e) { this.dc('error'); this.d('error', { where: 'message ' + (m && m.t), msg: String(e && e.message), at: String(e && e.stack).split('\n')[1] }); console.error('[island] message error:', e && e.message); }
  }

  onMessageInner(m) {
    if (this.state === 'controlling' && ['enter', 'attach', 'move', 'down', 'up', 'scroll', 'key', 'shot'].includes(m.t)) {
      this.dc('conflict'); this.d('conflict', { msg: m.t, wins: this.iWinConflict() });
      if (this.iWinConflict()) { console.log('[island] both computers tried to control; keeping control here'); return; }
      console.log('[island] both computers tried to control; giving way');
      this.state = 'idle';
      this.owner = 'peer';
      this.cooldownUntil = 0;
      this.notify();
      if (m.t !== 'enter' && m.t !== 'attach') return; // the request itself is handled below; stray input is dropped
    }
    if (m.t !== 'move' && (this.inX || this.inY)) this.drainMoves(); // clicks, keys and hand-overs happen at the real position
    switch (m.t) {
      case 'ping': this.send({ t: 'pong', ts: m.ts }); break;
      case 'pong': this.ds('rtt', Date.now() - m.ts); break;
      case 'rtoken': {
        if (this.peerHost) this.store.set('peers', { ...this.store.get('peers', {}), [this.peerHost]: m.token });
        break;
      }
      case 'layout':
        if (m.units !== 'mm') break; // an older layout in other units
        this.store.set('offsetUnits', 'mm');
        Object.assign(this.offsets, m.offsets);
        this.store.set('offsets', this.offsets);
        this.emit('layout');
        this.notify();
        break;
      case 'displays':
        if (this.peer) { this.peer.displays = m.displays || []; this.emit('layout'); }
        break;
      case 'enter': {
        const r = L.fromPlane(this.myDisplays, this.myOff(), { x: m.x, y: m.y });
        if (!r) break;
        this.ctrlMpp = m.mpp || 0;
        this.state = 'controlled';
        this.virt = { x: r.x, y: r.y };
        this.lastSet = { x: Math.round(r.x), y: Math.round(r.y) };
        this.placed(this.virt.x, this.virt.y);
        this.placeCursor(this.virt.x, this.virt.y);
        this.notify();
        this.verifyLanding('entry', this.virt, { x: m.x, y: m.y });
        break;
      }
      case 'move': { // queued and played out smoothly (see smoothTick)
        if (this.state !== 'controlled' || !this.peer) break;
        { const now = Date.now(); if (this.lastMoveRx && now - this.lastMoveRx < 500) this.ds('moveGap', now - this.lastMoveRx); this.lastMoveRx = now; this.dc('moves.rx'); }
        this.inX += m.dx; this.inY += m.dy;
        if (!this.smoothTimer) this.smoothTimer = setInterval(() => this.smoothTick(), 4);
        break;
      }
      case 'takeback': {
        if (this.state !== 'controlling') break;
        this.state = 'idle';
        this.owner = 'peer';
        this.cooldownUntil = Date.now() + 150;
        this.notify();
        break;
      }
      case 'leave': {
        if (this.state !== 'controlling') break;
        this.lastPeerPlane = { x: m.x, y: m.y };
        const r = L.fromPlane(this.myDisplays, this.myOff(), { x: m.x, y: m.y });
        const [vx, vy] = L.VEC[m.dir] || [0, 0];
        const back = 40;
        this.state = 'idle';
        this.owner = 'me';
        this.cooldownUntil = Date.now() + 150;
        if (r) {
          this.placeCursor(
            Math.min(r.d.x + r.d.w - 1, Math.max(r.d.x, r.x + vx * back)),
            Math.min(r.d.y + r.d.h - 1, Math.max(r.d.y, r.y + vy * back)),
          );
        }
        this.notify();
        break;
      }
      case 'clip': this.emit('clip', m); break;
      case 'notice': this.emit('notice', { title: String(m.title || '').slice(0, 60), text: String(m.text || '').slice(0, 140), kind: m.kind === 'err' ? 'err' : m.kind === 'progress' ? 'progress' : 'ok', ready: Math.min(10, Math.max(0, Number(m.ready) || 0)), hold: Math.min(10, Math.max(0, Number(m.hold) || 0)), step: Math.min(9, Number(m.step) || 0), of: Math.min(9, Number(m.of) || 0), glyph: m.glyph === 'there' ? 'there' : m.glyph === 'here' ? 'here' : '' }); break;
      case 'file-start': this.rxStart(m); break;
      case 'file-end': this.rxEnd(); break;
      case 'shot': if (this.state === 'controlled') this.shoot(); break;
      case 'key':
        if (this.state === 'controlled' && this.remoteHotkey(m)) break;
        this.dc(this.state === 'controlled' ? 'key.rx' : 'key.rx.ignored');
        if (this.state === 'controlled') { if ((this.keyRxLog = (this.keyRxLog || 0) + 1) <= 6) console.log('[island] remote key', m.c, m.d ? 'down' : 'up'); this.input.key(m.c, m.d, this.peerPlat); }
        break;
      case 'release': if (this.state === 'controlled') { this.state = 'idle'; this.owner = 'peer'; this.notify(); } break;
      case 'sync': this.emit('sync', m.items); break; // settings changed on the other computer
      case 'gazeidle': this.emit('gazeidle', { idle: Number(m.idle), cal: !!m.cal }); break; // how long the other computer has been left alone (decides which camera runs)
      case 'fxcolors': this.emit('fxcolors', m.colors); break; // the animation colours picked on the other computer
      case 'owner': this.owner = m.mine ? 'peer' : 'me'; break;
      case 'attach': { // the other computer's hardware now drives the pointer exactly where it is on this computer
        if (this.state !== 'idle') break;
        this.ctrlMpp = m.mpp || 0;
        const cur = (this.input.getPos && this.input.getPos()) || this.virt;
        const cl = L.clampToDisplays(this.myDisplays, cur.x, cur.y);
        if (!cl) break;
        this.state = 'controlled';
        this.virt = { x: cl.x, y: cl.y };
        this.lastSet = { x: Math.round(cl.x), y: Math.round(cl.y) };
        this.placed(this.virt.x, this.virt.y);
        this.mismatch = 0;
        this.notify();
        this.d('attach', { at: { x: Math.round(cl.x), y: Math.round(cl.y) }, mpp: m.mpp });
        break;
      }
      case 'xbtn':
        if (this.state === 'controlled' && m.k === 'chord') { const a = this.buttonMap.chord; if (!this.runAction(a, 'chord', 0)) this.shoot(); break; }
        if (this.state === 'controlled' && (m.k === 'back' || m.k === 'forward')) { const a = this.buttonMap[m.k]; this.runAction(!a || a === 'default' ? m.k : a, m.k, 0); } break;
      case 'down':
        if (this.state !== 'controlled') break;
        this.checkElevated();
        if (this.picker && (m.b === 1 || m.b === 2)) { if (m.b === 1) this.picker.pick(); else this.picker.cancel(); this.remoteEat = m.b; break; }
        if (m.b === 3) { const a = this.buttonMap.middle; if (a && a !== 'default') { this.midRemote = true; this.runAction(a, 'middle', 0); break; } }
        if ((this.pressRxLog = (this.pressRxLog || 0) + 1) <= 6) console.log('[island] remote button', m.b, 'down');
        this.input.press(m.b, m.n); break;
      case 'up':
        if (this.state !== 'controlled') break;
        if (this.remoteEat === m.b) { this.remoteEat = 0; break; }
        if (m.b === 3 && this.midRemote) { this.midRemote = false; this.emit('middle-up'); break; }
        this.input.release(m.b); break;
      case 'scroll':
        this.dc(this.state === 'controlled' ? 'scroll.rx' : 'scroll.rx.ignored');
        if (this.state !== 'controlled') break;
        if (m.n && m.x) { // thumb wheel notches coming in: a mapped action instead of scrolling sideways
          const t = m.x > 0 ? 'tiltRight' : 'tiltLeft';
          if (this.runAction(this.buttonMap[t], t)) { m = { ...m, x: 0 }; if (!m.y) break; }
        }
        if (m.n && this.prefs.smoothWheel) { this.remoteSmooth.add(m.x / 100, m.y / 100); this.dc('scroll.smooth'); }
        else { this.injectAt = Date.now(); this.input.scroll(m.x, m.y, this.scrollSettings.speed, this.scrollSettings.reverse); }
        break;
    }
  }
}

module.exports = { Link };
