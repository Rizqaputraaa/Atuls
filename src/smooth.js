// Turns the jumps of a mouse wheel into a glide, tuned per device:
//   step     pixels one notch scrolls
//   speed    acceleration: notches that follow each other quickly scroll further (1 = none)
//   duration milliseconds the glide takes to settle
// The input is counted in notches. Every notch adds to a pool of "distance still to scroll"; a fast timer pays it out following
// real elapsed time (so a busy moment only makes one bigger step, never a stall), decelerating like an ease-out.
const DEFAULT_TUNE = { step: 90, speed: 1.5, duration: 350 };

function cleanTune(t = {}) {
  const n = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  return { step: n(t.step, 10, 400, DEFAULT_TUNE.step), speed: n(t.speed, 1, 5, DEFAULT_TUNE.speed), duration: n(t.duration, 80, 1500, DEFAULT_TUNE.duration) };
}

class WheelSmoother {
  constructor(emit, getTune = () => DEFAULT_TUNE, { tickMs = 6, onGlide = null } = {}) {
    this.emit = emit; this.getTune = getTune; this.tickMs = tickMs; this.onGlide = onGlide;
    this.g = null; // statistics of the glide in progress (for the log)
    this.x = 0; this.y = 0; this.timer = null; this.last = 0; this.lastAdd = 0; this.streak = 0;
  }

  // notches: positive = down / right
  add(nx, ny) {
    const t = cleanTune(this.getTune());
    const now = Date.now();
    this.streak = now - this.lastAdd < 220 ? this.streak + 1 : 1;
    this.lastAdd = now;
    const gain = 1 + (t.speed - 1) * Math.min(this.streak - 1, 5) / 5;
    // turning around: what was still pending in the old direction is dropped, the page answers at once
    if (nx * this.x < 0) this.x = 0;
    if (ny * this.y < 0) this.y = 0;
    this.x += nx * t.step * gain; this.y += ny * t.step * gain;
    if (!this.g) this.g = { start: now, notches: 0, asked: 0, sent: 0, steps: 0, tune: t };
    this.g.notches += Math.abs(nx) + Math.abs(ny); this.g.asked += Math.abs(nx * t.step * gain) + Math.abs(ny * t.step * gain); this.g.tune = t;
    if (!this.timer) { this.last = now; this.timer = setInterval(() => this.tick(), this.tickMs); if (this.timer.unref) this.timer.unref(); }
  }

  tick() {
    const t = cleanTune(this.getTune());
    const now = Date.now(), dt = Math.max(1, now - this.last);
    this.last = now;
    const tau = t.duration / 4.5; // about 99% of the distance is done after `duration`
    const done = Math.abs(this.x) + Math.abs(this.y) < 0.6;
    const k = done ? 1 : 1 - Math.exp(-dt / tau);
    const dx = this.x * k, dy = this.y * k;
    this.x -= dx; this.y -= dy;
    if (dx || dy) { try { this.emit(dx, dy); } catch { /* keep going */ } if (this.g) { this.g.sent += Math.abs(dx) + Math.abs(dy); this.g.steps++; } }
    if (done) {
      this.x = this.y = 0; clearInterval(this.timer); this.timer = null;
      const g = this.g; this.g = null;
      if (g && this.onGlide) { try { this.onGlide({ ms: Date.now() - g.start, notches: +g.notches.toFixed(2), asked: Math.round(g.asked), sent: Math.round(g.sent), steps: g.steps, tune: g.tune }); } catch {} }
    }
  }

  // drop what is still pending (the pointer moved on: the rest of the glide would scroll something else)
  cancel() { this.x = this.y = 0; this.g = null; if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  flush() { if (this.x || this.y) { const dx = this.x, dy = this.y; this.x = this.y = 0; try { this.emit(dx, dy); } catch {} } if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

module.exports = { WheelSmoother, DEFAULT_TUNE, cleanTune };
