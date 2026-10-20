// On Windows, injecting input (SendInput) from the thread that owns low-level hooks can stall: the system waits for our own hook
// procedures, which can only run when this thread is free, and a stuck process can then hold the whole input system hostage.
// So presses, scrolling and keys are injected by a small helper process; moving the cursor stays here (it is synchronous and is
// read back immediately). Everything else is the plain implementation in input-core.js.
const path = require('path');
const core = require('./input-core');

if (process.platform !== 'win32' || process.env.ISLAND_INJECT_INLINE) {
  module.exports = core;
} else {
  const { fork } = require('child_process');
  let child = null;
  const ensure = () => {
    if (child && child.connected) return child;
    child = fork(path.join(__dirname, 'input-child.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    child.on('exit', (code) => { console.log('[island] input helper exited', code); child = null; });
    child.on('message', (m) => console.log('[island] input helper', JSON.stringify(m))); // the first few injected operations and every failure
    child.on('error', (e) => console.error('[island] input helper error:', e.message));
    return child;
  };
  const remote = (op) => (...args) => { try { ensure().send({ op, args }); } catch (e) { console.error('[island] input helper unavailable:', e.message); } };
  module.exports = {
    ...core,
    press: remote('press'), release: remote('release'), scroll: remote('scroll'), key: remote('key'),
    releaseAll: remote('releaseAll'), click: remote('click'), screenshot: remote('screenshot'),
    releaseLocalModifiers: remote('releaseLocalModifiers'),
  };
}
