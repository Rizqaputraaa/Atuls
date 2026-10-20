const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('onboard', { open: (pane) => ipcRenderer.send('onboard:open', String(pane)) });
