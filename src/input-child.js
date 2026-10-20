// Helper process: performs the input injection that must not run on the main app's thread (see input.js).
const core = require('./input-core');

let acked = 0;
process.on('message', (m) => {
  try { core[m.op](...(m.args || [])); if (acked++ < 12 && process.send) process.send({ ok: m.op, args: (m.args || []).slice(0, 2) }); }
  catch (e) { console.error('[island] inject', m.op, 'failed:', e.message); if (process.send) process.send({ err: m.op, why: e.message }); }
});
process.on('disconnect', () => process.exit(0));
setInterval(() => { if (!process.connected) process.exit(0); }, 2000).unref();
