const test = require('node:test');
const assert = require('node:assert');
const HK = require('../src/hotkeys');
const { Link } = require('../src/link');

const KEYS = ['A', 'K', '5', 'F5', 'Space', 'ArrowLeft', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const ACTIONS = ['default', 'none', 'radial', 'screenshot', 'desktopLeft'];

test('combos have one canonical text, left/right modifiers count the same', () => {
  assert.strictEqual(HK.comboOf(['ShiftRight', 'Ctrl', 'MetaRight'], 'K'), 'Ctrl+Shift+Meta+K');
  assert.strictEqual(HK.normalCombo('Shift+Ctrl+A', KEYS), 'Ctrl+Shift+A');
  assert.deepStrictEqual(HK.parseCombo('Alt+Meta+5', KEYS), { mods: ['Alt', 'Meta'], key: '5' });
});

test('invalid combos are refused: bare letters, unknown keys, duplicated or missing parts', () => {
  assert.strictEqual(HK.parseCombo('A', KEYS), null);
  assert.strictEqual(HK.parseCombo('Ctrl+Nope', KEYS), null);
  assert.strictEqual(HK.parseCombo('Ctrl+Ctrl+A', KEYS), null);
  assert.strictEqual(HK.parseCombo('Ctrl+', KEYS), null);
  assert.strictEqual(HK.parseCombo('Ctrl+Shift', KEYS), null);
  assert.strictEqual(HK.parseCombo('', KEYS), null);
  assert.notStrictEqual(HK.parseCombo('F5', KEYS), null, 'an F key may stand alone');
});

test('the shortcut list is cleaned: invalid, duplicate and "do nothing" entries are dropped, at most 12 kept', () => {
  const list = [
    { combo: 'Ctrl+Alt+K', action: 'radial' },
    { combo: 'Alt+Ctrl+K', action: 'screenshot' }, // the same combination
    { combo: 'A', action: 'radial' },
    { combo: 'Ctrl+A', action: 'none' },
    { combo: 'Ctrl+K', action: 'keys:Meta+5' },
    { combo: 'Ctrl+5', action: 'keys:Nope' },
    { combo: 'Shift+5', action: 'bogus' },
  ];
  assert.deepStrictEqual(HK.cleanHotkeys(list, KEYS, ACTIONS), [{ combo: 'Ctrl+Alt+K', action: 'radial' }, { combo: 'Ctrl+K', action: 'keys:Meta+5' }]);
  const many = KEYS.slice(0, 5).flatMap((k) => ['Ctrl', 'Alt', 'Shift'].map((m) => ({ combo: m + '+' + k, action: 'radial' })));
  assert.ok(HK.cleanHotkeys(many, KEYS, ACTIONS).length <= 12);
});

const mk = () => {
  const mem = {};
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
  const calls = [];
  const input = { releaseAll() {}, setPos() {}, getPos: () => ({ x: 1, y: 1 }), key: (n, d) => calls.push((d ? '+' : '-') + n) };
  const d = [{ x: 0, y: 0, w: 1920, h: 1080, dx: 0, dy: 0, dw: 300, dh: 170 }];
  const l = new Link({ input, getDisplays: () => d, store, downloadDir: '.', port: 47899 });
  return { l, calls };
};

test('a button mapped to a combination presses it: modifiers down, key, then up in reverse', () => {
  const { l, calls } = mk();
  assert.strictEqual(l.runAction('keys:Ctrl+Shift+K', 'back', 0), true);
  assert.deepStrictEqual(calls, ['+Ctrl', '+Shift', '+K', '-K', '-Shift', '-Ctrl']);
});

test('typing a shortcut on this computer runs its action once, and our own injected keys do not re-trigger it', () => {
  const { l, calls } = mk();
  l.hotkeys = [{ combo: 'Ctrl+Alt+K', action: 'keys:Meta+5' }];
  l.state = 'idle';
  l.onLocalKey(true, 'Ctrl'); l.onLocalKey(true, 'AltRight');
  l.onLocalKey(true, 'K');
  assert.deepStrictEqual(calls, ['+Meta', '+5', '-5', '-Meta']);
  const before = calls.length;
  l.onLocalKey(true, 'K'); // key repeat: inside the rate limit
  assert.strictEqual(calls.length, before);
  // the injected Meta+5 comes back through the hook: no shortcut matches it, and nothing loops
  l.onLocalKey(true, 'Meta'); l.onLocalKey(true, '5');
  assert.strictEqual(calls.length, before);
});

test('a plain key without the modifiers does nothing, and shortcuts are not looked up while controlling the other computer', () => {
  const { l, calls } = mk();
  l.hotkeys = [{ combo: 'Ctrl+Alt+K', action: 'keys:Meta+5' }];
  l.state = 'idle';
  l.onLocalKey(true, 'K');
  assert.strictEqual(calls.length, 0);
  l.onLocalKey(false, 'K');
  l.state = 'controlling';
  l.send = () => {};
  l.onLocalKey(true, 'Ctrl'); l.onLocalKey(true, 'Alt'); l.onLocalKey(true, 'K');
  assert.strictEqual(calls.length, 0);
});

test('keys typed on the other computer while it controls this one trigger this computer\'s shortcuts and are not injected', () => {
  const { l, calls } = mk();
  l.hotkeys = [{ combo: 'Ctrl+K', action: 'keys:Meta+5' }];
  l.state = 'controlled';
  assert.strictEqual(l.remoteHotkey({ c: 'Ctrl', d: true }), false);
  assert.strictEqual(l.remoteHotkey({ c: 'K', d: true }), true, 'the completing key is swallowed');
  assert.deepStrictEqual(calls, ['+Meta', '+5', '-5', '-Meta']);
  assert.strictEqual(l.remoteHotkey({ c: 'K', d: false }), true, 'and so is its release');
  assert.strictEqual(l.remoteHotkey({ c: 'K', d: false }), false);
  assert.strictEqual(l.remoteHotkey({ c: 'A', d: true }), false, 'other keys pass through');
});

test('the recorder takes the next combination, ignores plain letters, and Esc cancels', () => {
  const { l } = mk();
  const got = [];
  l.startRecording((c) => got.push(c));
  assert.strictEqual(l.recordKey(true, 'A'), true); // swallowed, no result yet
  assert.deepStrictEqual(got, []);
  l.recordKey(true, 'ControlLeftIsNotAName');
  l.recordKey(true, 'Ctrl'); l.recordKey(true, 'ShiftRight'); l.recordKey(true, 'K');
  assert.deepStrictEqual(got, ['Ctrl+Shift+K']);
  assert.strictEqual(l.recorder, null);
  l.startRecording((c) => got.push(c));
  l.recordKey(true, 'Escape');
  assert.deepStrictEqual(got, ['Ctrl+Shift+K', null]);
  l.startRecording((c) => got.push(c));
  l.recordKey(true, 'F5');
  assert.strictEqual(got[2], 'F5');
});
