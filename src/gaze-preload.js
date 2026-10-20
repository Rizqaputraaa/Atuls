const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gaze', {
  onCmd: (cb) => ipcRenderer.on('gaze:cmd', (_e, c) => cb(c)),
  sample: (s) => ipcRenderer.send('gaze:sample', s),
  state: (s) => ipcRenderer.send('gaze:state', s),
});
