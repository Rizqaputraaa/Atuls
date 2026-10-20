const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setOffset: (id, x, y) => ipcRenderer.invoke('layout:set', id, x, y),
  onLayout: (cb) => ipcRenderer.on('layout', (_e, l) => cb(l)),
});
