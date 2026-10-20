const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("windirstatAPI", {
  selectDirectory: () => ipcRenderer.invoke("windirstat:select-directory"),
  scanDirectory: (targetPath) => ipcRenderer.invoke("windirstat:scan-directory", targetPath),
  revealInFolder: (targetPath) => ipcRenderer.invoke("windirstat:reveal-in-folder", targetPath),
});
