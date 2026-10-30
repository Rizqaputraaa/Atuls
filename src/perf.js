// The numbers of the CPU page, like the Performance tab of the Windows Task Manager: CPU, memory, disk, network and graphics with a minute of history.
// Nothing runs in the background: it is worked out when the page asks (once a second while the page is in view), and the small programs that read the
// disk, network and graphics counters (Windows) are started then and stopped a few seconds after the page stopped asking.
const os = require('os');
const { spawn, execFile } = require('child_process');

const HIST = 60;
const push = (a, v) => { a.push(v); if (a.length > HIST) a.shift(); };

let winInfo; // GetPerformanceInfo (Windows): commit, cache, pools, processes, threads, handles
function loadWinInfo() {
  if (winInfo !== undefined) return winInfo;
  winInfo = null;
  if (process.platform !== 'win32') return winInfo;
  try {
    const koffi = require('koffi');
    const T = koffi.struct('PERF_INFO_ISL', { cb: 'uint32_t', CommitTotal: 'uintptr_t', CommitLimit: 'uintptr_t', CommitPeak: 'uintptr_t', PhysicalTotal: 'uintptr_t', PhysicalAvailable: 'uintptr_t', SystemCache: 'uintptr_t', KernelTotal: 'uintptr_t', KernelPaged: 'uintptr_t', KernelNonpaged: 'uintptr_t', PageSize: 'uintptr_t', HandleCount: 'uint32_t', ProcessCount: 'uint32_t', ThreadCount: 'uint32_t' });
    const fn = koffi.load('psapi.dll').func('int __stdcall GetPerformanceInfo(_Out_ PERF_INFO_ISL *info, uint32_t size)');
    winInfo = () => { const o = {}; return fn(o, koffi.sizeof(T)) ? o : null; };
  } catch { winInfo = null; }
  return winInfo;
}

// a counter read by typeperf, one value per second (many columns when the counter has many instances); the reader keeps the latest row
function counter(paths, onRow) {
  let child = null, buf = '', header = null;
  const start = () => {
    try { child = spawn('typeperf.exe', [...paths, '-si', '1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { child = null; return; }
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('"')) continue;
        const cells = l.split('","').map((c) => c.replace(/^"|"$/g, ''));
        if (!header) { header = cells; continue; }
        onRow(header, cells.map((c) => Number(c)));
      }
    });
    child.on('error', () => { child = null; });
    child.on('exit', () => { child = null; header = null; });
  };
  return { start: () => { if (!child) start(); }, stop: () => { if (child) { try { child.kill(); } catch {} child = null; header = null; } }, running: () => !!child };
}

class Perf {
  constructor() {
    this.cpuHist = []; this.memHist = []; this.diskHist = []; this.netHist = []; this.gpuHist = [];
    this.prev = null; this.sampleAt = 0; this.pct = 0;
    this.disk = null; this.sent = 0; this.recv = 0; this.gpu = null;
    this.lastAsk = 0; this.memExtra = null; this.memAt = 0;
    if (process.platform === 'win32') {
      this.cSpeed = counter(['\\Processor Information(_Total)\\% Processor Performance'], (_h, v) => { this.perf = Math.max(0, v[1] || 0); });
      this.cDisk = counter(['\\PhysicalDisk(_Total)\\% Disk Time'], (_h, v) => { this.disk = Math.min(100, Math.max(0, v[1] || 0)); });
      this.cNet = counter(['\\Network Interface(*)\\Bytes Sent/sec', '\\Network Interface(*)\\Bytes Received/sec'], (h, v) => {
        let s = 0, r = 0;
        for (let i = 1; i < h.length; i++) { const x = Number.isFinite(v[i]) ? v[i] : 0; if (/Bytes Sent/i.test(h[i])) s += x; else if (/Bytes Received/i.test(h[i])) r += x; }
        this.sent = s; this.recv = r;
      });
      this.cGpu = counter(['\\GPU Engine(*)\\Utilization Percentage'], (h, v) => {
        const by = {};
        for (let i = 1; i < h.length; i++) { const m = /engtype_([A-Za-z0-9 ]+)\)/.exec(h[i]); const k = m ? m[1] : 'x'; by[k] = (by[k] || 0) + (Number.isFinite(v[i]) ? v[i] : 0); }
        this.gpu = Math.min(100, Math.max(0, Math.max(0, ...Object.values(by))));
      });
      this.reaper = setInterval(() => { if (Date.now() - this.lastAsk > 8000) this.stopCounters(); }, 4000);
      if (this.reaper.unref) this.reaper.unref();
    }
  }

  stopCounters() { for (const c of [this.cSpeed, this.cDisk, this.cNet, this.cGpu]) if (c) c.stop(); }

  cpuSample() {
    const now = Date.now();
    if (this.prev && now - this.sampleAt < 900) return;
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
    if (this.prev && total > this.prev.total) this.pct = Math.min(100, Math.max(0, Math.round((1 - (idle - this.prev.idle) / (total - this.prev.total)) * 100)));
    this.prev = { idle, total }; this.sampleAt = now;
    push(this.cpuHist, this.pct);
    const mem = this.memory();
    push(this.memHist, Math.round((mem.used / mem.total) * 100));
    if (this.cDisk && this.cDisk.running()) { push(this.diskHist, this.disk || 0); push(this.netHist, this.sent + this.recv); push(this.gpuHist, this.gpu || 0); }
  }

  memory() {
    const total = os.totalmem(), info = loadWinInfo();
    if (info) {
      const p = info();
      if (p) {
        const ps = Number(p.PageSize) || 4096;
        return { total: Number(p.PhysicalTotal) * ps, used: (Number(p.PhysicalTotal) - Number(p.PhysicalAvailable)) * ps, avail: Number(p.PhysicalAvailable) * ps, committed: Number(p.CommitTotal) * ps, commitLimit: Number(p.CommitLimit) * ps, cached: Number(p.SystemCache) * ps, paged: Number(p.KernelPaged) * ps, nonpaged: Number(p.KernelNonpaged) * ps, processes: p.ProcessCount, threads: p.ThreadCount, handles: p.HandleCount };
      }
    }
    return { total, used: total - os.freemem(), avail: os.freemem() };
  }

  // the Mac counts inactive and cached pages as free: vm_stat tells (looked at every few seconds)
  macMemory(done) {
    if (process.platform !== 'darwin' || Date.now() - this.memAt < 3000) return done();
    this.memAt = Date.now();
    execFile('/usr/bin/vm_stat', { timeout: 3000 }, (err, out) => {
      if (!err) {
        const num = (k) => Number((new RegExp(k + ':\\s+(\\d+)').exec(out) || [])[1]) || 0, page = Number((/page size of (\d+)/.exec(out) || [])[1]) || 16384;
        const avail = (num('Pages free') + num('Pages inactive') + num('Pages speculative')) * page, total = os.totalmem();
        this.memExtra = { total, used: Math.max(0, total - avail), avail, cached: num('File-backed pages') * page };
      }
      done();
    });
  }

  // detail: the page with the lists is open (the disk, network and graphics readers run)
  snapshot(detail) {
    this.lastAsk = Date.now();
    this.macMemory(() => {});
    if (this.cSpeed) this.cSpeed.start(); // the speed is on the small card too
    if (detail && this.cDisk) { this.cDisk.start(); this.cNet.start(); this.cGpu.start(); }
    this.cpuSample();
    const mem = { ...this.memory(), ...(this.memExtra || {}) };
    const c = os.cpus();
    const out = {
      cpu: { pct: this.pct, hist: this.cpuHist, speed: (c[0] && c[0].speed) || 0, now: this.perf ? Math.round(((c[0] && c[0].speed) || 0) * this.perf / 100) : 0, cores: c.length, model: ((c[0] && c[0].model) || '').replace(/\s+/g, ' ').trim(), uptime: os.uptime() },
      mem: { ...mem, hist: this.memHist },
    };
    if (this.cDisk) {
      out.disk = { pct: this.disk, hist: this.diskHist, on: this.disk !== null };
      out.net = { sent: this.sent, recv: this.recv, hist: this.netHist };
      out.gpu = { pct: this.gpu, hist: this.gpuHist, on: this.gpu !== null };
    }
    return out;
  }

  close() { this.stopCounters(); if (this.reaper) clearInterval(this.reaper); }
}

module.exports = { Perf };
