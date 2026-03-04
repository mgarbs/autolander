'use strict';

const { autoUpdater } = require('electron-updater');
const { getMainWindow } = require('./window-manager');

function initUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    const win = getMainWindow();
    if (win) win.webContents.send('update:available', info);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = getMainWindow();
    if (win) win.webContents.send('update:downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
  });

  // Check for updates (skip in dev)
  if (process.env.NODE_ENV !== 'development' && !process.env.VITE_DEV_SERVER_URL) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
}

module.exports = { initUpdater };
