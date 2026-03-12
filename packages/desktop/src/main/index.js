'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { createWindow, getMainWindow } = require('./window-manager');
const { registerIpcHandlers, cleanupAdapters } = require('./ipc-handlers');
const { initUpdater } = require('./updater');

// Load ANTHROPIC_API_KEY from cloud .env if not already in environment
if (!process.env.ANTHROPIC_API_KEY) {
  const cloudEnvPath = path.join(__dirname, '..', '..', '..', 'cloud', '.env');
  try {
    const envContent = fs.readFileSync(cloudEnvPath, 'utf8');
    const match = envContent.match(/^ANTHROPIC_API_KEY=["']?([^"'\r\n]+)["']?/m);
    if (match) {
      process.env.ANTHROPIC_API_KEY = match[1];
    }
  } catch (_) {
    // Cloud .env not found — AI features will be disabled
  }
}

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

app.on('before-quit', async () => {
  await cleanupAdapters();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
