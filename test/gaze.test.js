const test = require('node:test');
const assert = require('node:assert');
const { Calibrator, ZoneTracker, median } = require('../src/gaze');

const CAL = { self: -15, peer: 15 }; // mid 0, half 15, dead band 0.3*15 = 4.5
const run = (zt, yaws, t0 = 0, step = 80) => {
  const out = [];
  yaws.forEach((y, i) => { const r = zt.update({ yaw: y }, t0 + i * step); if (r) out.push(r); });
  return out;
};
const rep = (v, n) => Array(n).fill(v);

test('median', () => { assert.strictEqual(median([3, 1, 2]), 2); assert.strictEqual(median([1, 2, 3, 4]), 2.5); });

test('calibrator computes centres from samples', () => {
  const c = new Calibrator();
  for (let i = 0; i < 20; i++) { c.add('self', { yaw: -15 + (i % 3) - 1 }); c.add('peer', { yaw: 20 + (i % 3) - 1 }); }
  const r = c.finish();
  assert.ok(r.ok);
  assert.ok(r.cal.self === 0 && Math.abs(r.cal.peer - 35) < 1);
});

test('calibrator rejects too few samples and too small separation', () => {
  const c = new Calibrator();
  c.add('self', { yaw: 0 });
  assert.strictEqual(c.finish().ok, false);
  const d = new Calibrator();
  for (let i = 0; i < 20; i++) { d.add('self', { yaw: 0 }); d.add('peer', { yaw: 2 }); }
  assert.strictEqual(d.finish().ok, false);
});

test('first zone is only a baseline, no switch', () => {
  const zt = new ZoneTracker({ dwellMs: 300 }); zt.setCalibration(CAL);
  assert.deepStrictEqual(run(zt, rep(-15, 10)), []);
  assert.strictEqual(zt.zone, 'self');
});

test('switches to peer after the dwell time, not before', () => {
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(CAL);
  run(zt, rep(-15, 5));
  // 80 ms steps: 300 ms dwell needs the candidate to hold for 4 samples
  assert.deepStrictEqual(run(zt, rep(15, 3), 1000), []);
  assert.deepStrictEqual(run(zt, rep(15, 5), 1000), ['peer']);
});

test('a short glance does not switch', () => {
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(CAL);
  run(zt, rep(-15, 5));
  assert.deepStrictEqual(run(zt, [15, 15, 15, -15, -15, -15, -15], 1000), []);
  assert.strictEqual(zt.zone, 'self');
});

test('a still head with noise inside the dead band never flips', () => {
  const zt = new ZoneTracker({ dwellMs: 300 }); zt.setCalibration(CAL);
  run(zt, rep(-15, 5));
  const noisy = Array.from({ length: 200 }, (_, i) => (i % 2 ? 3 : -3)); // sits around the midpoint but inside the band
  assert.deepStrictEqual(run(zt, noisy, 1000), []);
  assert.strictEqual(zt.zone, 'self');
});

test('hysteresis: after switching, returning needs to cross past the dead band', () => {
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(CAL);
  run(zt, rep(-15, 5));
  assert.deepStrictEqual(run(zt, rep(15, 6), 1000), ['peer']);
  // 2 degrees past the midpoint towards self is still inside the dead band
  assert.deepStrictEqual(run(zt, rep(-2, 20), 2000), []);
  assert.deepStrictEqual(run(zt, rep(-15, 6), 4000), ['self']);
});

test('losing the face never switches and restarts the dwell', () => {
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(CAL);
  run(zt, rep(-15, 5));
  zt.update({ yaw: 15 }, 1000); zt.update({ yaw: 15 }, 1100);
  assert.strictEqual(zt.update(null, 1200), null);
  assert.strictEqual(zt.update({ yaw: 15 }, 1300), null);
  assert.strictEqual(zt.update({ yaw: 15 }, 1400), null);
  assert.strictEqual(zt.zone, 'self');
});

test('works when the peer is on the negative-yaw side', () => {
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration({ self: 10, peer: -20 });
  run(zt, rep(10, 5));
  assert.deepStrictEqual(run(zt, rep(-20, 6), 1000), ['peer']);
});

test('no calibration: nothing happens', () => {
  const zt = new ZoneTracker({ dwellMs: 300 });
  assert.deepStrictEqual(run(zt, rep(50, 20)), []);
});

test('default settings react within ~150 ms at 24 fps', () => {
  const zt = new ZoneTracker(); zt.setCalibration(CAL);
  run(zt, rep(-15, 5), 0, 42);
  const t = []; let fired = -1;
  for (let i = 0; i < 10; i++) { if (zt.update({ yaw: 15 }, 1000 + i * 42) && fired < 0) fired = i * 42; }
  assert.ok(fired >= 0 && fired <= 200, 'fired at ' + fired);
});

test('screen below: pitch alone separates the screens, yaw stays the same', () => {
  const c = new Calibrator();
  for (let i = 0; i < 20; i++) { c.add('self', { yaw: 2, pitch: 0 + (i % 3) - 1 }); c.add('peer', { yaw: 2, pitch: 20 + (i % 3) - 1 }); }
  const r = c.finish();
  assert.ok(r.ok);
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(r.cal);
  const go = (p, t0) => { const out = []; for (let i = 0; i < 6; i++) { const z = zt.update({ yaw: 2, pitch: p }, t0 + i * 80); if (z) out.push(z); } return out; };
  assert.deepStrictEqual(go(0, 0), []);
  assert.deepStrictEqual(go(20, 1000), ['peer']);
  assert.deepStrictEqual(go(0, 3000), ['self']);
});

test('diagonal layout works through the projection', () => {
  const c = new Calibrator();
  for (let i = 0; i < 20; i++) { c.add('self', { yaw: 0, pitch: 0 }); c.add('peer', { yaw: 15, pitch: 15 }); }
  const { cal } = c.finish();
  const zt = new ZoneTracker({ alpha: 1, dwellMs: 300 }); zt.setCalibration(cal);
  const out = []; for (let i = 0; i < 6; i++) zt.update({ yaw: 0, pitch: 0 }, i * 80);
  for (let i = 0; i < 6; i++) { const z = zt.update({ yaw: 15, pitch: 15 }, 1000 + i * 80); if (z) out.push(z); }
  assert.deepStrictEqual(out, ['peer']);
});
