// Records how each run of the app starts and ends, so a crash or an unexpected quit can be explained afterwards:
//  - island-run.log (next to the settings): start, every quit request with the call stack that asked for it, exit codes,
//    uncaught errors, processes that died, and the verdict "clean shutdown" or "previous run ended abnormally"
//  - on macOS the newest system crash report (Electron-*.ips) from the abnormal run is summarised into the log
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let file = null, vfile = null, flag = null, started = Date.now();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
function line(msg) { try { fs.appendFileSync(file, `${stamp()}  ${msg}\n`); } catch {} }
// Everything is kept for a long test (a week of normal use): the run log rotates at 10 MB and keeps 10 files, the very chatty lines (every injected
// scroll step, key and window event) go to island-verbose.log, 20 MB x 4 files. Nothing is sent anywhere: the files stay in the data folder.
function rotate(f, maxBytes, keep) {
  try {
    if (!fs.existsSync(f) || fs.statSync(f).size <= maxBytes) return;
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`); } catch {} }
    fs.renameSync(f, `${f}.1`);
  } catch {}
}
let writes = 0;
function verbose(msg) {
  try {
    if (!vfile) return;
    fs.appendFileSync(vfile, `${stamp()}  ${msg}\n`);
    if (++writes % 500 === 0) { rotate(vfile, 20e6, 4); rotate(file, 10e6, 10); }
  } catch {}
}

function summariseCrash(since) {
  if (process.platform !== 'darwin') return;
  try {
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
    const files = fs.readdirSync(dir).filter((f) => /^Electron.*\.ips$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).filter((x) => x.t >= since - 60000).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(0, 2)) {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      const nl = txt.indexOf('\n');
      const body = JSON.parse(txt.slice(nl + 1));
      const th = (body.threads || [])[body.faultingThread] || {};
      const imgs = body.usedImages || [];
      const top = (th.frames || []).slice(0, 8).map((fr) => `${(imgs[fr.imageIndex] || {}).name || '?'}:${(fr.symbol || '').slice(0, 60)}`).join(' <- ');
      line(`crash report ${f}: ${(body.exception || {}).type || '?'} ${(body.exception || {}).signal || ''} (${(body.termination || {}).indicator || ''}) on thread "${th.name || '?'}" in ${body.procName || 'process'}`);
      line(`  stack: ${top}`);
    }
  } catch (e) { line('could not read crash reports: ' + e.message); }
}

function init() {
  try {
    const dir = app.getPath('userData');
    file = path.join(dir, 'island-run.log');
    vfile = path.join(dir, 'island-verbose.log');
    flag = path.join(dir, 'running.flag');
    rotate(file, 10e6, 10); rotate(vfile, 20e6, 4);
    let previous = 0;
    try { if (fs.existsSync(flag)) previous = fs.statSync(flag).mtimeMs; } catch {}
    line(`==== start pid ${process.pid} ${process.platform} electron ${process.versions.electron}`);
    if (previous) { line('PREVIOUS RUN ENDED WITHOUT A CLEAN SHUTDOWN (crash, kill or power loss)'); summariseCrash(previous); }
    fs.writeFileSync(flag, String(Date.now()));
  } catch (e) { console.error('[island] lifecycle log unavailable:', e.message); return; }

  // everything the app already prints with an [island] prefix is copied into the run log, so one file tells the whole story
  const NOISY = /scroll injected|inject key|double click injected|window now|page loaded|Security Warning|console-message|\[gaze\]/;
  for (const name of ['log', 'error']) {
    const orig = console[name].bind(console);
    console[name] = (...a) => {
      try { const s = typeof a[0] === 'string' ? a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ') : ''; if (/^\[(island|drop|drag|renderer|gaze)\]/.test(s)) { if (NOISY.test(s)) verbose((name === 'error' ? 'ERROR ' : '') + s.slice(0, 400)); else line((name === 'error' ? 'ERROR ' : '') + s.slice(0, 400)); } } catch {}
      return orig(...a);
    };
  }

  // who asked the app to quit: the call stack goes into the log
  for (const name of ['quit', 'exit']) {
    const orig = app[name].bind(app);
    app[name] = (...a) => { line(`app.${name}(${a.join(',')}) called from: ${String(new Error().stack).split('\n').slice(2, 5).map((s) => s.trim()).join(' | ')}`); return orig(...a); };
  }
  app.on('before-quit', () => line('before-quit'));
  app.on('will-quit', () => { line(`will-quit (up ${Math.round((Date.now() - started) / 1000)} s)`); });
  app.on('quit', (_e, code) => { line(`quit exitCode=${code}`); try { fs.unlinkSync(flag); line('clean shutdown'); } catch {} });
  process.on('exit', (code) => line(`process exit code=${code}`));
  process.on('uncaughtException', (e) => line('UNCAUGHT EXCEPTION: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => line('UNHANDLED REJECTION: ' + (e && e.stack || e)));
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) process.on(sig, () => { line(sig + ' received (the process was asked to stop from outside)'); process.exit(code); });
  app.on('child-process-gone', (_e, d) => line(`child process gone: ${d.type} ${d.name || ''} reason=${d.reason} exit=${d.exitCode}`));
  app.on('render-process-gone', (_e, wc, d) => line(`renderer gone: reason=${d.reason} exit=${d.exitCode} url=${String(wc.getURL()).split('/').pop()}`));
}

// the last lines of the run log (for "Copy run log" in the settings)
function tail(n = 400) {
  try { const t = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10)); return t.slice(-n - 1).join(String.fromCharCode(10)); } catch (e) { return 'no run log: ' + e.message; }
}
module.exports = { init, line, verbose, tail, get file() { return file; } };
