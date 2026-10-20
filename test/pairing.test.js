const test = require('node:test');
const assert = require('node:assert');
const { Link } = require('../src/link');

let nextPort = 47830;
const mk = () => {
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
  const input = { releaseAll() {}, setPos() {}, getPos: () => ({ x: 100, y: 100 }) };
  const d = [{ x: 0, y: 0, w: 1920, h: 1080, dx: 0, dy: 0, dw: 300, dh: 170, mpp: 0.16 }];
  const l = new Link({ input, getDisplays: () => d, store, downloadDir: '.', port: nextPort++ });
  l.start();
  return l;
};
const stopAll = (...ls) => ls.forEach((l) => l.stop());
const once = (l, ev) => new Promise((r) => l.once(ev, r));

test('first pairing: both people see the same numbers, confirm, and the link opens', async () => {
  const a = mk(), b = mk();
  const sasA = once(a, 'sas'), sasB = once(b, 'sas');
  const done = b.connect('127.0.0.1', a.pin, 'right', null, a.port);
  const [sa, sb] = await Promise.all([sasA, sasB]);
  assert.strictEqual(sa.code, sb.code);
  assert.match(sa.code, /^\d{6}$/);
  assert.strictEqual(a.sock, null, 'not linked before both confirm');
  a.sasAnswer(true);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(a.sock, null, 'still waiting for the other person');
  b.sasAnswer(true);
  await done;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(a.sock && b.sock);
  stopAll(a, b);
});

test('a saved token reconnects without asking for numbers again', async () => {
  const a = mk(), b = mk();
  const sas = once(a, 'sas');
  const first = b.connect('127.0.0.1', a.pin, 'right', null, a.port);
  await sas; a.sasAnswer(true); await once(b, 'sas').catch(() => {}); // b's own event may already have fired
  b.sasAnswer(true);
  await first;
  b.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  let asked = false;
  a.on('sas', () => { asked = true; }); b.on('sas', () => { asked = true; });
  await b.connect('127.0.0.1', '', 'right', a.id, a.port);
  assert.strictEqual(asked, false);
  assert.ok(b.sock);
  stopAll(a, b);
});

test('one person saying the numbers differ stops the pairing on both sides', async () => {
  const a = mk(), b = mk();
  const sasA = once(a, 'sas');
  const done = b.connect('127.0.0.1', a.pin, 'right', null, a.port);
  await sasA;
  a.sasAnswer(false);
  await assert.rejects(done, /do not match/);
  assert.strictEqual(a.sock, null);
  assert.strictEqual(b.sock, null);
  stopAll(a, b);
});

test('a wrong code is refused, and five wrong codes lock and change the code', async () => {
  const a = mk(), b = mk();
  const pin = a.pin;
  await assert.rejects(b.connect('127.0.0.1', '000000', 'right', null, a.port), /Wrong pairing code/);
  for (let i = 0; i < 4; i++) await b.connect('127.0.0.1', '000001', 'right', null, a.port).catch(() => {});
  assert.notStrictEqual(a.pin, pin, 'the code changes after five failures');
  await assert.rejects(b.connect('127.0.0.1', a.pin, 'right', null, a.port), /Too many wrong codes/);
  stopAll(a, b);
});

test('when the usual port is held by something else, the next free port is used and reported', async () => {
  const a = mk();                        // holds a port
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
  const d = [{ x: 0, y: 0, w: 1920, h: 1080, dx: 0, dy: 0, dw: 300, dh: 170, mpp: 0.16 }];
  const b = new Link({ input: { releaseAll() {}, setPos() {}, getPos: () => ({ x: 1, y: 1 }) }, getDisplays: () => d, store, downloadDir: '.', port: a.port }); // asks for the same port
  b.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(b.port, a.port + 1);
  assert.strictEqual(b.status().port, a.port + 1);
  // and a computer that knows that port can pair with it
  const sasB = once(b, 'sas'), sasC = once(a, 'sas');
  const done = a.connect('127.0.0.1', b.pin, 'right', null, b.port);
  await Promise.all([sasB, sasC]);
  a.sasAnswer(true); b.sasAnswer(true);
  await done;
  assert.ok(a.sock && b.sock);
  stopAll(a, b);
});
