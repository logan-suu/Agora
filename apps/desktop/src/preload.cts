const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld(
  'agoraDesktop',
  Object.freeze({
    status: () => ipcRenderer.invoke('agora:status'),
    restart: () => ipcRenderer.invoke('agora:restart'),
    quit: () => ipcRenderer.invoke('agora:quit'),
  }),
);
