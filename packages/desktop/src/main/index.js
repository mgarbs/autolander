'use strict';

// Polyfill globals that undici expects but Electron's Node.js doesn't have.
// Without this, `require('undici')` crashes with "ReferenceError: File is not
// defined" on Electron 28 (Node 18) when a newer undici is installed.
if (typeof globalThis.File === 'undefined') {
  const { Blob } = require('buffer');
  globalThis.File = class File extends Blob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { createWindow, getMainWindow } = require('./window-manager');
const { registerIpcHandlers, cleanupAdapters } = require('./ipc-handlers');
const { initUpdater } = require('./updater');

// Disable hardware GPU acceleration to prevent GPU process crashes when
// multiple hidden BrowserWindows (feed sync, image fetcher) run alongside
// the main window. On macOS, this avoids SharedImageManager corruption
// that cascades into network service crashes and SSL failures.
app.disableHardwareAcceleration();

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
