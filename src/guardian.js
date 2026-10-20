// Watchdog process. Island Link installs system-wide mouse and keyboard hooks inside its main process. If that process freezes, every mouse and
// key press of the whole computer waits for it, and a frozen process can end up stuck in the system for good (only a restart of Windows removes
// it). So a separate, tiny process watches it: the app sends a beat every second; if the beats stop for HANG_MS the app is ended at once (before
// the freeze can drag on) and a fresh copy is started. Started by main.js with: node guardian.js <app pid> <exe> <args json> <cwd> <log file> <restarts so far>
const fs = require('fs');
const { spawn } = require('child_process');

const [mainPid, exe, argsJson, cwd, logFile, restartsSoFar] = [Number(process.argv[2]), process.argv[3], process.argv[4], process.argv[5], process.argv[6], Number(process.argv[7] || 0)];
const HANG_MS = Number(process.env.ISLAND_HANG_MS) || 6000; // longer than any wait the app does on purpose (nothing in the app blocks its main thread that long any more)
const MAX_RESTARTS = 3; // in a row: a freeze that keeps coming back is not hidden by restarting for ever
const startedAt = Date.now();

const log = (t) => { try { fs.appendFileSync(logFile, new Date().toISOString().replace('T', ' ').replace('Z', '') + '  guardian: ' + t + '\n'); } catch {} };

let last = Date.now(), prevTick = Date.now(), recovering = false;
process.on('message', (m) => {
  if (m === 'beat') last = Date.now();
  else if (m === 'stop') process.exit(0);
});
process.on('disconnect', () => { if (!recovering) process.exit(0); }); // the app ended by itself

setInterval(() => {
  const now = Date.now();
  // this timer itself was late (the computer slept, or was suspended): that says nothing about the app
  if (now - prevTick > 3000) last = now;
  prevTick = now;
  if (!recovering && now - last > HANG_MS) recover();
}, 1000);

function recover() {
  recovering = true;
  log('the app (pid ' + mainPid + ') has not answered for ' + Math.round((Date.now() - last) / 1000) + ' s: ending it');
  try { process.kill(mainPid, 'SIGKILL'); } catch (e) { log('could not end it: ' + e.message); }
  const before = Date.now() - startedAt > 10 * 60 * 1000 ? 0 : restartsSoFar; // it ran well for ten minutes: the earlier freezes do not count
  if (before >= MAX_RESTARTS) { log('it froze ' + (before + 1) + ' times in a row: not starting it again'); process.exit(0); }
  setTimeout(() => {
    try {
      const env = { ...process.env, ISLAND_RECOVERED: String(before + 1) };
      delete env.ELECTRON_RUN_AS_NODE; // this process runs as plain Node; the app it starts must not
      const child = spawn(exe, JSON.parse(argsJson || '[]'), { cwd, detached: true, stdio: 'ignore', env });
      child.unref();
      log('started a new copy (pid ' + child.pid + ')');
    } catch (e) { log('could not start a new copy: ' + e.message); }
    process.exit(0);
  }, 1500);
}
