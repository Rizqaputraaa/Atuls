const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loupe', {
  onFrame: (cb) => ipcRenderer.on('loupe-frame', (_e, d) => cb(d)),
});
