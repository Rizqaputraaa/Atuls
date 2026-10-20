const test = require('node:test');
const assert = require('node:assert');
const { Link } = require('../src/link');

const mk = () => {
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
  const input = { releaseAll() {}, setPos() {}, getPos: () => ({ x: 100, y: 100 }) };
  const d = [{ x: 0, y: 0, w: 1920, h: 1080, dx: 0, dy: 0, dw: 1920, dh: 1080 }];
  const l = new Link({ input, getDisplays: () => d, store, downloadDir: '.' });
  const sent = [];
  l.sock = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() {} };
  l.peer = { id: 'p', name: 'peer', plat: 'darwin', displays: d };
  return { l, sent };
};
test('looking at the other computer while it controls us hands the pointer back (takeback)', () => {
  const { l, sent } = mk();
  l.state = 'controlled';
  assert.strictEqual(l.gazeEnter(), true);
  assert.strictEqual(l.state, 'idle');
  assert.ok(sent.some((m) => m.t === 'takeback'));
});
test('does not hand back while typing', () => {
  const { l, sent } = mk();
  l.state = 'controlled';
  l.lastKeyAt = Date.now();
  assert.strictEqual(l.gazeEnter(), 'busy');
  assert.strictEqual(l.state, 'controlled');
  assert.strictEqual(sent.length, 0);
});
test('idle: gaze enter starts controlling and sends enter', () => {
  const { l, sent } = mk();
  assert.strictEqual(l.gazeEnter(), true);
  assert.strictEqual(l.state, 'controlling');
  assert.ok(sent.some((m) => m.t === 'enter'));
});

test('gaze does not take the pointer while the mouse is being used by hand', () => {
  const { l, sent } = mk();
  l.state = 'idle';
  l.onLocalMove(10, 10); // the hand just moved the mouse
  assert.strictEqual(l.gazeEnter(), 'busy');
  assert.strictEqual(l.state, 'idle');
  assert.ok(!sent.some((m) => m.t === 'enter'));
  l.lastHandMoveAt = Date.now() - 2000; // quiet for a while
  assert.strictEqual(l.gazeEnter(), true);
  assert.strictEqual(l.state, 'controlling');
});
