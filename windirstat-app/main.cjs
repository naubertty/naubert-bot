const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const { scanDirectoryTree } = require("./scanner.cjs");

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "WinDirStat 2.9.3 Desktop (REA Clean-Room)",
    backgroundColor: "#0b0f17",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("windirstat:select-directory", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Selecione uma pasta ou unidade para analisar no WinDirStat",
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("windirstat:scan-directory", async (_event, targetPath) => {
  return scanDirectoryTree(targetPath);
});

ipcMain.handle("windirstat:reveal-in-folder", async (_event, targetPath) => {
  if (targetPath) {
    shell.showItemInFolder(targetPath);
  }
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
