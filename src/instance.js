// One A-tuls per user data folder, and it must still start when an earlier run left a "stuck" process behind.
//
// Electron keeps one instance per data folder with a lock. A process that froze inside the system (it cannot be ended any more, not even by
// End task: only a restart of Windows removes it) keeps that lock for ever, so every new start used to say "already running" and quit.
// This module tells a running instance from a dead one: each instance writes its process id next to its settings, and a start that finds the
// lock taken checks whether that process is still alive. If it is not, a second data folder is used ("A-tuls (2)", with a copy of the
// settings), and when the first one is free again the newer settings are merged back.
const fs = require('fs');
const path = require('path');

const STILL_ACTIVE = 259;

// is this process id a process that is still running (an ended process whose last thread is stuck counts as dead)
function alive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    if (process.platform === 'win32') {
      const koffi = require('koffi');
      const k = koffi.load('kernel32.dll');
      const open = k.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
      const exitCode = k.func('bool __stdcall GetExitCodeProcess(void *h, _Out_ uint32_t *code)');
      const close = k.func('bool __stdcall CloseHandle(void *h)');
      const h = open(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (!h) return koffi.errno() === 5; // access denied: it exists, it belongs to somebody else
      const c = new Uint32Array(1);
      const ok = exitCode(h, c);
      close(h);
      return ok ? c[0] === STILL_ACTIVE : true;
    }
    process.kill(pid, 0);
    return true;
  } catch (e) { return !!e && e.code === 'EPERM'; }
}

const readPid = (dir) => { try { return Number(fs.readFileSync(path.join(dir, 'instance.pid'), 'utf8')) || 0; } catch { return 0; } };
const writePid = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'instance.pid'), String(process.pid)); } catch {} };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// a new data folder starts with the settings and pairing tokens of the usual one. The tokens are stored sealed with a key that lives in the
// folder's own "Local State" file, so that file comes along (a new folder would otherwise have a new key and could not read them).
function seedConfig(from, to) {
  try {
    fs.mkdirSync(to, { recursive: true });
    if (!fs.existsSync(path.join(to, 'config.json')) && fs.existsSync(path.join(from, 'config.json'))) {
      fs.copyFileSync(path.join(from, 'config.json'), path.join(to, 'config.json'));
      if (fs.existsSync(path.join(from, 'Local State'))) fs.copyFileSync(path.join(from, 'Local State'), path.join(to, 'Local State'));
    }
  } catch {}
}

// back in the usual folder: settings changed meanwhile in a second folder are newer and come back
function mergeBack(base, others) {
  const merged = [];
  for (const d of others) {
    const f = path.join(d, 'config.json');
    if (mtime(f) > mtime(path.join(base, 'config.json'))) {
      try { fs.copyFileSync(f, path.join(base, 'config.json')); fs.renameSync(f, f + '.merged'); merged.push(d); } catch {}
    }
  }
  return merged;
}

// does something answer on this local port within 1.5 s (a connection that is accepted but never answered belongs to a frozen leftover)
function answersOnPort(port) {
  try {
    const code = "const s=require('net').connect(" + port + ",'127.0.0.1',()=>s.write(['GET / HTTP/1.1','Host: x','Connection: Upgrade','Upgrade: websocket','Sec-WebSocket-Version: 13','Sec-WebSocket-Key: aXNsYW5kLWxpbmstcHJvYmU=','',''].join(String.fromCharCode(13,10))));s.on('data',()=>process.exit(0));s.on('error',()=>process.exit(2));setTimeout(()=>process.exit(1),1500)";
    const r = require('child_process').spawnSync(process.execPath, ['-e', code], { timeout: 2500, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    return r.status === 0;
  } catch { return true; } // cannot tell: do not risk two
}

// The app used to be called "Island Link": its settings (and the key that opens the sealed pairing tokens) live in a data folder with the old
// name. The first start under the new name takes the newest of those over, so nothing has to be set up again.
const LEGACY_FOLDERS = ['Island Link', 'island-link', 'IslandLink'];
function migrateLegacy(base) {
  try {
    if (fs.existsSync(path.join(base, 'config.json'))) return null;
    const parent = path.dirname(base);
    let best = null;
    for (const name of LEGACY_FOLDERS) {
      const d = path.join(parent, name);
      if (d === base) continue;
      const t = mtime(path.join(d, 'config.json'));
      if (t && (!best || t > best.t)) best = { d, t };
    }
    if (!best) return null;
    fs.mkdirSync(base, { recursive: true });
    fs.copyFileSync(path.join(best.d, 'config.json'), path.join(base, 'config.json'));
    if (fs.existsSync(path.join(best.d, 'Local State'))) fs.copyFileSync(path.join(best.d, 'Local State'), path.join(base, 'Local State'));
    return best.d;
  } catch { return null; }
}

// -> { ok, dir, fallback } to go on, or { ok: false, running } to stop (running: another instance is really there)
function claim(app) {
  const base = app.getPath('userData');
  const migratedFrom = migrateLegacy(base);
  const dirs = [base, base + ' (2)', base + ' (3)'];
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    if (i) { app.setPath('userData', dir); seedConfig(base, dir); }
    if (app.requestSingleInstanceLock()) {
      writePid(dir);
      const merged = i === 0 ? mergeBack(base, dirs.slice(1)) : [];
      return { ok: true, dir, fallback: i > 0, merged, migratedFrom };
    }
    const other = readPid(dir);
    // no process id on record (a run of an older version): a live A-tuls answers on its port, a stuck leftover only holds the socket
    if (other ? alive(other) : answersOnPort(Number(process.env.ISLAND_PORT) || 47800)) return { ok: false, running: true, pid: other };
    // the holder is dead: a stuck leftover; the next folder is tried
  }
  return { ok: false, running: false };
}

module.exports = { claim, alive, answersOnPort, migrateLegacy };
