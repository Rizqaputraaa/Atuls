// Diagnostics: a compact event log plus a short summary report that judges how well the screen hand-over and the
// pointer behaved (accuracy of where the pointer lands, delay and jitter of the link, takebacks, blocked crossings).
// Files, in the app's data folder: diag.log (one JSON line per event, rotated at ~1.5 MB) and diag-summary.txt.
const fs = require('fs');
const path = require('path');

class Stat {
  constructor() { this.n = 0; this.sum = 0; this.min = Infinity; this.max = -Infinity; this.sample = []; }
  add(v) {
    this.n++; this.sum += v;
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    if (this.sample.length < 400) this.sample.push(v); else this.sample[Math.floor(Math.random() * 400)] = v;
  }
  pct(p) { if (!this.sample.length) return 0; const s = [...this.sample].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
  text(unit = '') {
    if (!this.n) return 'no data';
    const f = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    return `${this.n} samples, avg ${f(this.sum / this.n)}${unit}, p95 ${f(this.pct(0.95))}${unit}, max ${f(this.max)}${unit}`;
  }
}

class Diag {
  constructor(dir, label, info = () => ({})) {
    this.dir = dir; this.label = label; this.info = info;
    this.file = path.join(dir, 'diag.log');
    this.summaryFile = path.join(dir, 'diag-summary.txt');
    this.started = Date.now();
    this.stats = {}; this.counts = {}; this.recent = [];
    this.written = 0;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    this.timer = setInterval(() => this.writeSummary(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  event(type, data = {}) {
    try {
      this.counts[type] = (this.counts[type] || 0) + 1;
      if (!/^(wall|feedback|move|rx|tx)/.test(type)) { try { require('./lifecycle').line('event ' + type + ' ' + JSON.stringify(data).slice(0, 200)); } catch {} }
      const line = JSON.stringify({ t: new Date().toISOString().slice(11, 23), type, ...data });
      this.recent.push(line.length > 220 ? line.slice(0, 220) + '...' : line);
      if (this.recent.length > 14) this.recent.shift();
      fs.appendFileSync(this.file, line + '\n');
      if (++this.written % 200 === 0 && fs.statSync(this.file).size > 1.5e6) { try { fs.renameSync(this.file, this.file + '.1'); } catch {} }
    } catch { /* diagnostics must never break the app */ }
  }

  count(name, n = 1) { this.counts[name] = (this.counts[name] || 0) + n; }
  stat(name, v) { if (Number.isFinite(v)) (this.stats[name] || (this.stats[name] = new Stat())).add(v); }
  st(name, unit) { return (this.stats[name] || new Stat()).text(unit); }
  c(name) { return this.counts[name] || 0; }

  // plain-language verdicts, so the report can be read (or pasted) without knowing the internals
  findings() {
    const out = [];
    const rtt = this.stats.rtt, mv = this.stats.moveGap, ent = this.stats.entryErrPx, entmm = this.stats.entryErrMm;
    if (rtt && rtt.n > 3) out.push(rtt.pct(0.95) > 30 ? `link delay is high (p95 ${Math.round(rtt.pct(0.95))} ms): movement will look uneven` : `link delay is fine (p95 ${Math.round(rtt.pct(0.95))} ms)`);
    if (mv && mv.n > 30) out.push(mv.pct(0.95) > 25 ? `movement arrives in bursts (p95 gap ${Math.round(mv.pct(0.95))} ms, max ${Math.round(mv.max)} ms)` : `movement arrives evenly (p95 gap ${Math.round(mv.pct(0.95))} ms)`);
    if (ent && ent.n) out.push(ent.max > 6 ? `pointer lands off target by up to ${Math.round(ent.max)} px (avg ${Math.round(ent.sum / ent.n)} px)` : `pointer lands where asked (max error ${Math.round(ent.max * 10) / 10} px)`);
    if (entmm && entmm.n && entmm.max > 4) out.push(`landing position differs from the physical alignment by up to ${Math.round(entmm.max * 10) / 10} mm`);
    const minutes = Math.max(1, (Date.now() - this.started) / 60000);
    if (this.c('takeback') > 3 * minutes) out.push(`many takebacks (${this.c('takeback')} in ${Math.round(minutes)} min): control keeps bouncing back`);
    if (this.c('conflict')) out.push(`${this.c('conflict')} control clash(es) between the computers were resolved`);
    if (this.c('wall') > 20) out.push(`the pointer hit an obstacle ${this.c('wall')} times while being steered (screen edge or a part the system will not enter)`);
    if (this.c('hook.reinstall')) out.push(`input hooks were reinstalled ${this.c('hook.reinstall')} time(s) (sleep, lock, or silent drop)`);
    if (this.c('error')) out.push(`${this.c('error')} error(s) caught: see diag.log`);
    if (this.c('block.resist') + this.c('block.drag') + this.c('block.freelook')) out.push(`crossings held back: ${this.c('block.resist')} by edge resistance, ${this.c('block.drag')} while dragging, ${this.c('block.freelook')} by a game`);
    return out.length ? out : ['nothing unusual so far'];
  }

  summary() {
    const i = this.info() || {};
    const lines = [
      `Island Link diagnostics - ${this.label} - up ${Math.round((Date.now() - this.started) / 1000)} s`,
      `link: ${i.linked ? 'connected to ' + i.peer : 'not connected'} | state ${i.state} | pointer owner ${i.owner} | edge resistance ${i.edge} | game guard ${i.guard}`,
      `screens: ${i.screens || '-'}`,
      `layout: ${i.layout || '-'}`,
      '',
      'FINDINGS', ...this.findings().map((f) => '  - ' + f),
      '',
      'MEASUREMENTS',
      `  link round trip:        ${this.st('rtt', ' ms')}`,
      `  gap between moves (rx): ${this.st('moveGap', ' ms')}`,
      `  landing error (px):     ${this.st('entryErrPx', ' px')}`,
      `  landing error (mm):     ${this.st('entryErrMm', ' mm')}`,
      `  movement smoothing lag: ${this.st('smoothQueue', ' px waiting')}`,
      '',
      'COUNTS',
      '  ' + Object.entries(this.counts).sort().map(([k, v]) => `${k}=${v}`).join('  ') || '-',
      '',
      'LAST EVENTS', ...this.recent.map((l) => '  ' + l),
    ];
    return lines.join('\n');
  }

  writeSummary() { try { fs.writeFileSync(this.summaryFile, this.summary()); } catch {} }
  stop() { clearInterval(this.timer); this.writeSummary(); }
}

module.exports = { Diag };
