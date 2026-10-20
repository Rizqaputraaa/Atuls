const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fx', { onPlay: (cb) => ipcRenderer.on('fx-play', (_e, d) => cb(d)) });
