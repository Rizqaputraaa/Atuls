const test = require('node:test');
const assert = require('node:assert');
const { Link } = require('../src/link');

const mk = () => {
  const calls = [];
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
  const input = { releaseAll() {}, setPos: (x, y) => calls.push([x, y]), getPos: () => ({ x: 100, y: 100 }) };
  const d = [{ x: 0, y: 0, w: 1920, h: 1080, dx: 0, dy: 0, dw: 300, dh: 170 }];
  return { l: new Link({ input, getDisplays: () => d, store, downloadDir: '.', port: 47898 }), calls };
};

test('outside the mouse hook the cursor is placed at once', () => {
  const { l, calls } = mk();
  l.placeCursor(5, 6);
  assert.deepStrictEqual(calls, [[5, 6]]);
});

test('inside the mouse hook callback the cursor is placed only after the callback has returned', async () => {
  const { l, calls } = mk();
  let during = null;
  l.onWinMouseInner = () => { l.placeCursor(7, 8); during = calls.length; return false; };
  l.onWinMouse(0x200, { x: 1, y: 1, flags: 0 });
  assert.strictEqual(during, 0, 'not called from inside the callback');
  assert.strictEqual(l.inHook, false);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, [[7, 8]]);
});

test('a hook callback that throws still lets go of the hook state', () => {
  const { l } = mk();
  l.onWinMouseInner = () => { throw new Error('boom'); };
  assert.strictEqual(l.onWinMouse(0x200, { x: 1, y: 1, flags: 0 }), false);
  assert.strictEqual(l.inHook, false);
});
