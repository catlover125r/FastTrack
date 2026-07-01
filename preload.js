const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fasttrack', {
  saveMp3: (data, defaultName) => ipcRenderer.invoke('save-mp3', data, defaultName),
  openAudio: () => ipcRenderer.invoke('open-audio'),
  onCommand: (fn) => ipcRenderer.on('cmd', (e, cmd) => fn(cmd)),
});
