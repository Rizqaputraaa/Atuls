const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { claim, alive } = require('../src/instance');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'island-inst-'));
// a stand-in for Electron's app: the lock answers come from a list
const fakeApp = (base, locks) => {
  let dir = base; const asked = [];
  return { asked, getPath: () => dir, setPath: (_n, d) => { dir = d; }, requestSingleInstanceLock: () => { asked.push(dir); return locks.shift(); } };
};
const deadPid = async () => {
  const c = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((r) => c.on('exit', r));
  return c.pid;
};

test('a running process is alive, an ended one is not', async () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)']);
  assert.strictEqual(alive(c.pid), true);
  c.kill();
  await new Promise((r) => c.on('exit', r));
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(alive(c.pid), false);
  assert.strictEqual(alive(0), false);
});

test('the lock is free: this run uses the usual folder and records its process id', () => {
  const base = tmp();
  const app = fakeApp(base, [true]);
  const r = claim(app);
  assert.deepStrictEqual([r.ok, r.dir, r.fallback], [true, base, false]);
  assert.strictEqual(Number(fs.readFileSync(path.join(base, 'instance.pid'), 'utf8')), process.pid);
});

test('the lock is held by a really running A-tuls: this start gives up', async () => {
  const base = tmp();
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 8000)']);
  fs.writeFileSync(path.join(base, 'instance.pid'), String(live.pid));
  const r = claim(fakeApp(base, [false]));
  live.kill();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.running, true);
});

test('the lock is held by a dead process (a stuck leftover): a second folder with the settings is used', async () => {
  const base = tmp();
  fs.writeFileSync(path.join(base, 'config.json'), '{"gazeOn":true}');
  fs.writeFileSync(path.join(base, 'Local State'), '{"key":"abc"}');
  fs.writeFileSync(path.join(base, 'instance.pid'), String(await deadPid()));
  const app = fakeApp(base, [false, true]);
  const r = claim(app);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.dir, base + ' (2)');
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'config.json'), 'utf8'), '{"gazeOn":true}');
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'Local State'), 'utf8'), '{"key":"abc"}', 'the key that opens the sealed tokens comes along');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

// a live A-tuls answers on its port; a stuck leftover accepts the connection and never answers (the servers live in another process)
const serverProcess = (kind) => new Promise((resolve) => {
  const src = kind === 'live'
    ? "const { WebSocketServer } = require('" + path.join(__dirname, '..', 'node_modules', 'ws').split(path.sep).join('/') + "'); const s = new WebSocketServer({ port: 0, host: '127.0.0.1' }); s.on('listening', () => console.log(s.address().port));"
    : "const s = require('net').createServer(() => {}); s.listen(0, '127.0.0.1', () => console.log(s.address().port));";
  const c = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  c.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), stop: () => c.kill() }));
});

test('lock taken, no process id on record, something answers on the port: a running A-tuls, this start gives up', async () => {
  const srv = await serverProcess('live');
  const keep = process.env.ISLAND_PORT; process.env.ISLAND_PORT = String(srv.port);
  try {
    const r = claim(fakeApp(tmp(), [false]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.running, true);
  } finally { srv.stop(); if (keep === undefined) delete process.env.ISLAND_PORT; else process.env.ISLAND_PORT = keep; }
});

test('lock taken, no process id on record, the port accepts but never answers: a stuck leftover, a second folder is used', async () => {
  const srv = await serverProcess('mute');
  const keep = process.env.ISLAND_PORT; process.env.ISLAND_PORT = String(srv.port);
  try {
    const base = tmp();
    const r = claim(fakeApp(base, [false, true]));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fallback, true);
    fs.rmSync(r.dir, { recursive: true, force: true });
  } finally { srv.stop(); if (keep === undefined) delete process.env.ISLAND_PORT; else process.env.ISLAND_PORT = keep; }
});

test('back in the usual folder, newer settings from the second folder are merged back once', () => {
  const base = tmp(), alt = base + ' (2)';
  fs.mkdirSync(alt);
  fs.writeFileSync(path.join(base, 'config.json'), '{"old":1}');
  fs.writeFileSync(path.join(alt, 'config.json'), '{"new":1}');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(alt, 'config.json'), later, later);
  const r = claim(fakeApp(base, [true]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), '{"new":1}');
  assert.ok(fs.existsSync(path.join(alt, 'config.json.merged')));
  fs.rmSync(alt, { recursive: true, force: true });
});

test('the first start under the new name takes over the settings of the newest old-named folder', () => {
  const parent = tmp();
  const base = path.join(parent, 'A-tuls'), oldPc = path.join(parent, 'Island Link'), oldMac = path.join(parent, 'island-link');
  fs.mkdirSync(oldPc); fs.mkdirSync(oldMac);
  fs.writeFileSync(path.join(oldMac, 'config.json'), '{"which":"older"}');
  fs.writeFileSync(path.join(oldPc, 'config.json'), '{"which":"newer"}');
  fs.writeFileSync(path.join(oldPc, 'Local State'), '{"key":"k"}');
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(oldMac, 'config.json'), past, past);
  const r = claim(fakeApp(base, [true]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.migratedFrom, oldPc);
  assert.strictEqual(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), '{"which":"newer"}');
  assert.strictEqual(fs.readFileSync(path.join(base, 'Local State'), 'utf8'), '{"key":"k"}');
  // once the new folder has settings it is left alone
  fs.writeFileSync(path.join(oldPc, 'config.json'), '{"which":"changed later"}');
  const again = claim(fakeApp(base, [true]));
  assert.strictEqual(again.migratedFrom, null);
  assert.strictEqual(fs.readFileSync(path.join(base, 'config.json'), 'utf8'), '{"which":"newer"}');
});
