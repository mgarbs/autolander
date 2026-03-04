'use strict';

const path = require('path');
const os = require('os');
const { getMainWindow } = require('./window-manager');

// Worker modules (lazy-loaded)
let agentClient = null;
let commandRouter = null;

const DATA_DIR = path.join(os.homedir(), '.autolander', 'data');

function registerIpcHandlers(ipcMain) {
  // --- Agent connection ---
  ipcMain.handle('agent:login', async (_event, { serverUrl, accessToken }) => {
    const { AgentClient } = require('../worker/agent-client');
    agentClient = new AgentClient({ serverUrl, accessToken, dataDir: DATA_DIR });

    agentClient.on('status', (status) => {
      const win = getMainWindow();
      if (win) win.webContents.send('agent:status-update', status);
    });

    await agentClient.connect();
    return { connected: true };
  });

  ipcMain.handle('agent:logout', async () => {
    if (agentClient) {
      agentClient.disconnect();
      agentClient = null;
    }
    return { disconnected: true };
  });

  ipcMain.handle('agent:get-status', () => {
    if (!agentClient) return { connected: false, fbSessionValid: false };
    return agentClient.getStatus();
  });

  ipcMain.handle('agent:get-config', () => {
    const Store = require('electron-store');
    const store = new Store();
    return {
      serverUrl: store.get('serverUrl', ''),
      username: store.get('username', ''),
    };
  });

  // --- Facebook operations ---
  ipcMain.handle('fb:login', async () => {
    const { FbAuthAdapter } = require('../worker/fb-auth-adapter');
    const adapter = new FbAuthAdapter({ dataDir: DATA_DIR });

    adapter.on('frame', (frameData) => {
      const win = getMainWindow();
      if (win) win.webContents.send('fb:frame', frameData);
    });

    adapter.on('progress', (progress) => {
      const win = getMainWindow();
      if (win) win.webContents.send('fb:progress', progress);
    });

    const result = await adapter.startLogin();
    return result;
  });

  ipcMain.handle('fb:get-status', async () => {
    const { FbSessionManager } = require('../../lib/fb-session-manager');
    const manager = new FbSessionManager({ dataDir: DATA_DIR });
    return manager.getStatus();
  });

  ipcMain.handle('fb:post-vehicle', async (_event, { vehicle, listing }) => {
    const { FbPosterAdapter } = require('../worker/fb-poster-adapter');
    const adapter = new FbPosterAdapter({ dataDir: DATA_DIR });

    adapter.on('progress', (progress) => {
      const win = getMainWindow();
      if (win) win.webContents.send('fb:progress', progress);
    });

    return adapter.postVehicle(vehicle, listing);
  });

  ipcMain.handle('fb:check-inbox', async () => {
    const { FbInboxAdapter } = require('../worker/fb-inbox-adapter');
    const adapter = new FbInboxAdapter({ dataDir: DATA_DIR });
    return adapter.checkInbox();
  });

  ipcMain.handle('fb:send-message', async (_event, { threadId, text, expectedBuyer }) => {
    const { FbInboxAdapter } = require('../worker/fb-inbox-adapter');
    const adapter = new FbInboxAdapter({ dataDir: DATA_DIR });
    return adapter.sendMessage(threadId, text, expectedBuyer);
  });

  ipcMain.handle('fb:start-assisted-post', async (_event, { vehicle }) => {
    const { FbPosterAdapter } = require('../worker/fb-poster-adapter');
    const adapter = new FbPosterAdapter({ dataDir: DATA_DIR });

    adapter.on('frame', (frameData) => {
      const win = getMainWindow();
      if (win) win.webContents.send('fb:frame', frameData);
    });

    adapter.on('progress', (progress) => {
      const win = getMainWindow();
      if (win) win.webContents.send('fb:progress', progress);
    });

    return adapter.startAssistedPost(vehicle);
  });

  ipcMain.handle('fb:cancel-assisted-post', async () => {
    // TODO: cancel ongoing session
    return { cancelled: true };
  });
}

module.exports = { registerIpcHandlers };
