const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', {
  onInit: (cb) => ipcRenderer.on('picker-init', (_e, img) => cb(img)),
  done: (hex) => ipcRenderer.send('picker-done', hex),
  ready: () => ipcRenderer.send('picker-ready'),
});
