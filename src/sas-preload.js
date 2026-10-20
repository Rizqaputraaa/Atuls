const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sas', {
  onShow: (cb) => ipcRenderer.on('sas:show', (_e, d) => cb(d)),
  answer: (yes) => ipcRenderer.send('sas:answer', !!yes),
});
