const { ipcRenderer } = require('electron');

// Relative mouse movement while the pointer is locked: the cursor stays frozen and hidden on this computer
let dx = 0, dy = 0, timer = 0;
const flush = () => { timer = 0; ipcRenderer.send('ov-move', dx, dy); dx = dy = 0; };

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousemove', (e) => {
    if (!document.pointerLockElement) return;
    dx += e.movementX; dy += e.movementY;
    if (!timer) timer = setTimeout(flush, 4);
  });
  // buttons: the overlay has the focus and the pointer lock, so it sees every click even when the system-wide hook does not (DOM: 0 left, 1 middle, 2 right, 3 back, 4 forward)
  document.addEventListener('mousedown', (e) => { ipcRenderer.send('ov-btn', true, e.button, e.detail); }, true);
  document.addEventListener('mouseup', (e) => { ipcRenderer.send('ov-btn', false, e.button, e.detail); }, true);
  document.addEventListener('wheel', (e) => { e.preventDefault(); ipcRenderer.send('ov-wheel', e.deltaX, e.deltaY, e.deltaMode); }, { passive: false });
  document.addEventListener('pointerlockchange', () => ipcRenderer.send('ov-lock', !!document.pointerLockElement));
  document.addEventListener('pointerlockerror', () => ipcRenderer.send('ov-lock', false));
});
