// Drinking water: a reminder every so many minutes. Plain logic without Electron (main.js owns the timers, the messages to the other computer
// and the banner); everything that changes it goes through a method here.
// The settings (on / off and the number of minutes) belong to the computer they were set on; when the person drank and when the last reminder was
// shown are shared, so the other computer does not remind again straight away.
const MIN = 60000;
const NAG_EVERY = 10 * MIN; // while nothing was drunk, a reminder comes back after this long ...
const NAG_TIMES = 3; // ... this many times in all, then the normal interval takes over again
const clamp = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d; };
const DEFAULTS = { on: true, every: 60 };

function cleanCfg(c, base = DEFAULTS) {
  c = c && typeof c === 'object' ? c : {};
  return { on: c.on === undefined ? !!base.on : !!c.on, every: clamp(c.every, 5, 480, base.every) };
}

class Water {
  constructor(saved, now = Date.now) {
    this.now = now;
    const s = saved && typeof saved === 'object' ? saved : {};
    this.cfg = cleanCfg(s.cfg);
    this.lastDrinkAt = Number(s.lastDrinkAt) || 0;
    this.lastRemindAt = Number(s.lastRemindAt) || 0;
    this.nag = Number(s.nag) || 0;
    this.snoozeUntil = Number(s.snoozeUntil) || 0;
    this.rev = Number(s.rev) || 0; // when it was last changed by a person: the newer copy wins between two computers
    this.startedAt = now(); // a reminder never comes right when the app starts
    this.alert = false; // a reminder is showing and nobody has answered it yet
  }

  toJSON() { return { cfg: this.cfg, lastDrinkAt: this.lastDrinkAt, lastRemindAt: this.lastRemindAt, nag: this.nag, snoozeUntil: this.snoozeUntil, rev: this.rev }; }

  touch() { this.rev = Math.max(this.now(), this.rev + 1); }

  // the person drank: the next reminder is one interval from now
  drink() { this.lastDrinkAt = this.now(); this.nag = 0; this.snoozeUntil = 0; this.alert = false; this.touch(); }

  set(patch) { this.cfg = cleanCfg({ ...this.cfg, ...(patch || {}) }, this.cfg); this.touch(); }

  snooze(min) { this.snoozeUntil = this.now() + clamp(min, 1, 240, 15) * MIN; this.nag = 0; this.alert = false; this.touch(); }

  // when the next reminder is due (0 = none: switched off)
  nextAt() {
    if (!this.cfg.on) return 0;
    let t;
    if (this.nag > 0 && this.nag < NAG_TIMES && this.lastRemindAt) t = this.lastRemindAt + NAG_EVERY;
    else t = Math.max(this.lastDrinkAt, this.lastRemindAt, this.startedAt) + this.cfg.every * MIN;
    return Math.max(t, this.snoozeUntil);
  }

  due() { const n = this.nextAt(); return !!n && this.now() >= n; }

  // a reminder is being shown now
  ring() { this.lastRemindAt = this.now(); this.nag = this.nag >= NAG_TIMES ? 1 : this.nag + 1; this.alert = true; this.touch(); }

  // the other computer has a newer copy: take when the person drank and the reminder state (the settings and what only belongs to this run stay)
  adopt(w) {
    if (!w || typeof w !== 'object' || !(Number(w.rev) > this.rev)) return false;
    const n = new Water(w, this.now);
    const theirsIsLater = n.lastRemindAt >= this.lastRemindAt;
    this.lastDrinkAt = n.lastDrinkAt; this.lastRemindAt = n.lastRemindAt; this.nag = n.nag; this.snoozeUntil = n.snoozeUntil; this.rev = n.rev;
    if (theirsIsLater) this.alert = false; // the other computer showed the reminder (or answered it)
    return true;
  }

  status() { return { ...this.cfg, nextAt: this.nextAt(), lastDrinkAt: this.lastDrinkAt, snoozeUntil: this.snoozeUntil, alert: this.alert, rev: this.rev }; }
}

module.exports = { Water, DEFAULTS, cleanCfg };
