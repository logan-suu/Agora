const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld(
  'agoraDesktop',
  Object.freeze({
    selectDirectory: (input: { projectId: string; taskId: string; actionId: string }) =>
      ipcRenderer.invoke('agora:select-directory', input),
    status: () => ipcRenderer.invoke('agora:status'),
    restart: () => ipcRenderer.invoke('agora:restart'),
    quit: () => ipcRenderer.invoke('agora:quit'),
  }),
);
