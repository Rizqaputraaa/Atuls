const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rs', {
  load: () => ipcRenderer.invoke('rs:load'),
  save: (cfg) => ipcRenderer.invoke('rs:save', cfg),
  trigger: (k) => ipcRenderer.invoke('rs:trigger', k),
  search: (q) => ipcRenderer.invoke('rs:search', q),
  icon: (p, logo) => ipcRenderer.invoke('rs:icon', p, logo),
  folder: () => ipcRenderer.invoke('rs:folder'),
  itemIcon: (it) => ipcRenderer.invoke('rs:itemicon', it),
  pickIcon: () => ipcRenderer.invoke('rs:pickicon'),
  test: () => ipcRenderer.invoke('rs:test'),
});
