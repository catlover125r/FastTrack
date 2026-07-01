const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

let win;

function send(cmd) {
  if (win) win.webContents.send('cmd', cmd);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 860,
    minHeight: 480,
    title: 'FastTrack',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#2b2b2b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

const menuTemplate = [
  {
    label: 'FastTrack',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'quit' },
    ],
  },
  {
    label: 'File',
    submenu: [
      { label: 'Import Audio…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { type: 'separator' },
      { label: 'Export MP3…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
      { type: 'separator' },
      { label: 'Split at Playhead', accelerator: 'CmdOrCtrl+T', click: () => send('split') },
      { label: 'Duplicate', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
      { label: 'Delete', click: () => send('delete') },
    ],
  },
  { role: 'windowMenu' },
];

ipcMain.handle('save-mp3', async (event, data, defaultName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export MP3',
    defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
    filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(data));
  return res.filePath;
});

ipcMain.handle('open-audio', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import Audio',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'aif', 'aiff', 'caf', 'webm'] },
    ],
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    const b = fs.readFileSync(p);
    return {
      name: path.basename(p),
      // slice: a Buffer's backing ArrayBuffer can be a shared pool
      data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  });
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
