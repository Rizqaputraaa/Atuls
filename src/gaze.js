// Pure logic for "Look to switch": turns head-pose samples into a stable "which screen am I looking at" decision.
// No Electron and no camera in here, so it can be unit tested (test/gaze.test.js).

const TARGETS = ['self', 'peer'];
const MIN_SEPARATION = 6;   // smallest distance between the two calibrated centres, in degrees of head angle (yaw and pitch together)
const MIN_SAMPLES = 8;      // per target

const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The signal is head angle in degrees (iris tracking is left out for now). Calibration finds the line between the two
// "look" points in (yaw, pitch) space, so a screen to the side (yaw) and a screen below (pitch) both work:
// the signal is the position along that line, 0 at this screen and D at the other one.
const feature = (s, cal) => {
  if (!cal || !cal.axis) return s.yaw; // older yaw-only calibration
  return (s.yaw - cal.origin.y) * cal.axis.y + ((s.pitch || 0) - cal.origin.p) * cal.axis.p;
};

// Collects ~2 s of samples per target while the user looks at that screen.
class Calibrator {
  constructor() { this.samples = { self: [], peer: [] }; }
  add(target, sample) {
    if (this.samples[target] && sample && Number.isFinite(sample.yaw)) this.samples[target].push(sample);
  }
  count(target) { return this.samples[target].length; }
  finish() {
    const { self, peer } = this.samples;
    if (self.length < MIN_SAMPLES || peer.length < MIN_SAMPLES) return { ok: false, error: 'not enough face samples (is your face visible?)' };
    const c2 = (l) => ({ y: median(l.map((s) => s.yaw)), p: median(l.map((s) => s.pitch || 0)) });
    const a = c2(self), b = c2(peer);
    const D = Math.hypot(b.y - a.y, b.p - a.p);
    if (D < MIN_SEPARATION) return { ok: false, error: 'the two screens look too alike - turn or tilt your head more between them' };
    const cal = { self: 0, peer: D, origin: { y: a.y, p: a.p }, axis: { y: (b.y - a.y) / D, p: (b.p - a.p) / D } };
    const spread = (l, t) => median(l.map((s) => Math.abs(feature(s, cal) - t)));
    cal.spread = Math.max(spread(self, 0), spread(peer, D));
    return { ok: true, cal };
  }
}

// Decides the stable zone ('self' | 'peer') with smoothing, a dead band around the midpoint (hysteresis)
// and a dwell time. update() returns the new zone only when it CHANGES; the first zone is just a baseline.
class ZoneTracker {
  constructor({ dwellMs = 140, hyst = 0.25, alpha = 0.6, gapMs = 600 } = {}) {
    Object.assign(this, { dwellMs, hyst, alpha, gapMs });
    this.cal = null;
    this.reset();
  }
  setCalibration(cal) { this.cal = cal && Number.isFinite(cal.self) && Number.isFinite(cal.peer) ? cal : null; this.reset(); }
  reset() { this.zone = null; this.cand = null; this.candSince = 0; this.smooth = null; this.lastT = 0; }
  update(sample, now) {
    if (!this.cal) return null;
    if (!sample || !Number.isFinite(sample.yaw)) { this.cand = null; return null; } // face lost: switch nothing
    if (this.smooth === null || now - this.lastT > this.gapMs) { this.smooth = null; this.cand = null; }
    this.lastT = now;
    const f = feature(sample, this.cal);
    this.smooth = this.smooth === null ? f : this.smooth + this.alpha * (f - this.smooth);
    const { self, peer } = this.cal;
    const dir = Math.sign(peer - self), half = Math.abs(peer - self) / 2;
    const u = (this.smooth - (self + peer) / 2) * dir;     // > 0 towards the peer's screen
    const band = this.hyst * half;
    let want = this.cand ? this.cand.zone : this.zone;
    if (u > band) want = 'peer'; else if (u < -band) want = 'self'; // inside the band: keep what we had
    if (want === this.zone) { this.cand = null; return null; }
    if (want === null) return null;
    if (!this.cand || this.cand.zone !== want) { this.cand = { zone: want }; this.candSince = now; }
    if (now - this.candSince < this.dwellMs) return null;
    const prev = this.zone;
    this.zone = want; this.cand = null;
    return prev === null ? null : want;
  }
}

module.exports = { Calibrator, ZoneTracker, feature, median, MIN_SEPARATION, MIN_SAMPLES, TARGETS };
