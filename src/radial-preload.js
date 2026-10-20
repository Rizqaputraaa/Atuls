const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('radial', {
  onOpen: (cb) => ipcRenderer.on('radial-open', (_e, data) => cb(data)),
  onCursor: (cb) => ipcRenderer.on('radial-cursor', (_e, v) => cb(v)),
  onRelease: (cb) => ipcRenderer.on('radial-release', () => cb()),
  action: (a) => ipcRenderer.send('radial-action', a),
  run: (ref) => ipcRenderer.send('radial-run', ref),
  color: (hex) => ipcRenderer.send('radial-color', hex),
  close: () => ipcRenderer.send('radial-close'),
});
