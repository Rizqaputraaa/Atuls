const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, fork } = require('child_process');

const GUARDIAN = path.join(__dirname, '..', 'src', 'guardian.js');
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'island-guard-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a stand-in for the app (it only sleeps) and a stand-in for "the next copy" (it writes a note and ends)
function setup(restarts = 0) {
  const dir = tmpdir(), marker = path.join(dir, 'next-copy.txt'), log = path.join(dir, 'run.log');
  const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const nextCopy = JSON.stringify(['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ recovered: process.env.ISLAND_RECOVERED, asNode: process.env.ELECTRON_RUN_AS_NODE || null }))`]);
  const g = fork(GUARDIAN, [String(app.pid), process.execPath, nextCopy, dir, log, String(restarts)], { env: { ...process.env, ISLAND_HANG_MS: '2500', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return { app, g, marker, log, cleanup: () => { try { app.kill(); } catch {} try { g.kill(); } catch {} } };
}

test('an app that keeps beating is left alone, and "stop" ends the watchdog', async () => {
  const s = setup();
  const beat = setInterval(() => { try { s.g.send('beat'); } catch {} }, 500);
  await wait(4500);
  assert.strictEqual(alive(s.app.pid), true, 'a healthy app is not touched');
  clearInterval(beat);
  s.g.send('stop');
  await new Promise((r) => s.g.once('exit', r));
  assert.strictEqual(fs.existsSync(s.marker), false);
  s.cleanup();
});

test('an app that stops answering is ended and the next copy is started (as an app, not as plain Node)', async () => {
  const s = setup();
  s.g.send('beat');
  await wait(6500); // 2.5 s without a beat, then the end and the start 1.5 s later
  assert.strictEqual(alive(s.app.pid), false, 'the frozen app was ended');
  assert.ok(fs.existsSync(s.marker), 'the next copy was started');
  const note = JSON.parse(fs.readFileSync(s.marker, 'utf8'));
  assert.strictEqual(note.recovered, '1');
  assert.strictEqual(note.asNode, null, 'ELECTRON_RUN_AS_NODE must not leak into the new app');
  assert.match(fs.readFileSync(s.log, 'utf8'), /guardian: .*not answered.*\n.*started a new copy/);
  s.cleanup();
});

test('after three freezes in a row the app is ended but not started again', async () => {
  const s = setup(3);
  s.g.send('beat');
  await wait(6500);
  assert.strictEqual(alive(s.app.pid), false);
  assert.strictEqual(fs.existsSync(s.marker), false, 'no new copy');
  assert.match(fs.readFileSync(s.log, 'utf8'), /not starting it again/);
  s.cleanup();
});

test('when the app ends by itself (the channel closes) the watchdog goes too and starts nothing', async () => {
  const s = setup();
  s.g.send('beat');
  s.app.kill(); // not a freeze: a normal end; the channel to the watchdog belongs to the parent, so closing it stands in for that
  s.g.disconnect();
  await new Promise((r) => s.g.once('exit', r));
  await wait(1500);
  assert.strictEqual(fs.existsSync(s.marker), false);
  s.cleanup();
});
