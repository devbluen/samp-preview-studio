// Gives the page the native folder picker of the desktop app (see sources.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    pickGameFolder: () => ipcRenderer.invoke('pick-game-folder'),
    forgetGameFolder: () => ipcRenderer.invoke('forget-game-folder'),
});
