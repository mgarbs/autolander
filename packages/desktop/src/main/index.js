'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { createWindow, getMainWindow } = require('./window-manager');
const { registerIpcHandlers } = require('./ipc-handlers');
const { initUpdater } = require('./updater');

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  registerIpcHandlers(ipcMain);
  createWindow();
  initUpdater();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
