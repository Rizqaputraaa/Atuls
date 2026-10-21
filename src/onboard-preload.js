const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('onboard', { open: (pane) => ipcRenderer.send('onboard:open', String(pane)), onStatus: (cb) => ipcRenderer.on('onboard:status', (_e, st) => cb(st)) });
