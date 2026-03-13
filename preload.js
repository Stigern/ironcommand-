const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ironServer', {
  start: () => ipcRenderer.invoke('server-start'),
  stop: () => ipcRenderer.invoke('server-stop'),
  status: () => ipcRenderer.invoke('server-status'),
  onStatus: (callback) => ipcRenderer.on('server-status', (_event, data) => callback(data)),
});
