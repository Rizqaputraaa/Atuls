const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('onboard', { open: (pane) => ipcRenderer.send('onboard:open', String(pane)), restart: () => ipcRenderer.send('onboard:restart'), onStatus: (cb) => ipcRenderer.on('onboard:status', (_e, st) => cb(st)) });
