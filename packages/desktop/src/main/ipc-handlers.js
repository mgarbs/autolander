'use strict';

const path = require('path');
const os = require('os');
const { BrowserWindow, shell } = require('electron');
const { getMainWindow } = require('./window-manager');

// Worker modules (lazy-loaded)
let agentClient = null;
let commandRouter = null;
let fbPosterAdapter = null;
let fbInboxAdapter = null;
let fbAuthAdapter = null;
let agentCredentials = { serverUrl: '', accessToken: '' };
let inboxPolling = null;

const DATA_DIR = path.join(os.homedir(), '.autolander', 'data');
process.env.AUTO_SALES_DATA_DIR = DATA_DIR;

let ipcFbAuthAdapter = null;
let ipcFbPosterAdapter = null;
let ipcFbInboxAdapter = null;

function getIpcFbAuthAdapter() {
  if (!ipcFbAuthAdapter) {
    const { FbAuthAdapter } = require('./adapters/fb-auth-adapter');
    ipcFbAuthAdapter = new FbAuthAdapter({
      dataDir: DATA_DIR,
      salespersonId: 'default',
      mainWindow: getMainWindow(),
    });
  }
  ipcFbAuthAdapter.setMainWindow(getMainWindow());
  return ipcFbAuthAdapter;
}

function getIpcFbPosterAdapter() {
  if (!ipcFbPosterAdapter) {
    const { FbPosterAdapter } = require('./adapters/fb-poster-adapter');
    ipcFbPosterAdapter = new FbPosterAdapter({
      dataDir: DATA_DIR,
      salespersonId: 'default',
      mainWindow: getMainWindow(),
    });
  }
  ipcFbPosterAdapter.setMainWindow(getMainWindow());
  return ipcFbPosterAdapter;
}

function getIpcFbInboxAdapter() {
  // Reuse the CommandRouter's adapter to avoid two browser instances
  // hitting FB simultaneously (doubles rate limit risk)
  if (fbInboxAdapter) {
    fbInboxAdapter.setMainWindow(getMainWindow());
    return fbInboxAdapter;
  }
  if (!ipcFbInboxAdapter) {
    const { FbInboxAdapter } = require('./adapters/fb-inbox-adapter');
    ipcFbInboxAdapter = new FbInboxAdapter({
      dataDir: DATA_DIR,
      salespersonId: 'default',
      mainWindow: getMainWindow(),
    });
  }
  ipcFbInboxAdapter.setMainWindow(getMainWindow());
  return ipcFbInboxAdapter;
}

function asErrorResult(error) {
  return { error: error && error.message ? error.message : 'Unknown error' };
}

function sendAgentStatus(status) {
  const win = getMainWindow();
  if (!win) return;
  win.webContents.send('agent:status', status);
  // Backward compatibility for current preload bridge.
  win.webContents.send('agent:status-update', status);
}

function ensureAgentInfrastructure() {
  if (!agentClient) {
    const { AgentClient } = require('../worker/agent-client');
    agentClient = new AgentClient({ dataDir: DATA_DIR });
    agentClient.on('status', sendAgentStatus);
  }

  if (!commandRouter) {
    const { CommandRouter } = require('../worker/command-router');
    const { FbPosterAdapter } = require('./adapters/fb-poster-adapter');
    const { FbInboxAdapter } = require('./adapters/fb-inbox-adapter');
    const { FbAuthAdapter } = require('./adapters/fb-auth-adapter');

    fbPosterAdapter = fbPosterAdapter || new FbPosterAdapter({ dataDir: DATA_DIR, mainWindow: getMainWindow() });
    fbInboxAdapter = fbInboxAdapter || new FbInboxAdapter({ dataDir: DATA_DIR, mainWindow: getMainWindow() });
    fbAuthAdapter = fbAuthAdapter || new FbAuthAdapter({ dataDir: DATA_DIR, mainWindow: getMainWindow() });
    commandRouter = new CommandRouter({
      agentClient,
      fbPosterAdapter,
      fbInboxAdapter,
      fbAuthAdapter,
    });
  }
}

function updateAgentFbSessionStatus(valid) {
  if (!agentClient) return;
  agentClient.setFbSessionValid(!!valid);
}

function registerIpcHandlers(ipcMain) {
  // --- Agent connection ---
  ipcMain.handle('agent:login', async (_event, { serverUrl, accessToken }) => {
    console.log('[ipc] agent:login called, serverUrl:', serverUrl);
    ensureAgentInfrastructure();
    const nextServerUrl = serverUrl || agentCredentials.serverUrl;
    const nextAccessToken = accessToken || agentCredentials.accessToken;
    agentCredentials = { serverUrl: nextServerUrl, accessToken: nextAccessToken };
    try {
      await agentClient.connect(nextServerUrl, nextAccessToken);
    } catch (err) {
      console.error('[ipc] agent:login connect error:', err.message);
    }
    sendAgentStatus(agentClient.getStatus());

    // Start inbox polling for auto-reply
    try {
      if (!inboxPolling) {
        const { InboxPolling } = require('../worker/inbox-polling');
        inboxPolling = new InboxPolling({ fbInboxAdapter: getIpcFbInboxAdapter() });
        console.log('[ipc] InboxPolling created');
      }
      inboxPolling.start(getIpcFbInboxAdapter(), {
        serverUrl: nextServerUrl,
        accessToken: nextAccessToken,
      });
      console.log('[ipc] InboxPolling started');
    } catch (err) {
      console.error('[ipc] InboxPolling start error:', err.message);
    }

    return { connected: true, ...agentClient.getStatus() };
  });

  ipcMain.handle('agent:logout', async () => {
    if (agentClient) {
      agentClient.disconnect();
      updateAgentFbSessionStatus(false);
    }
    agentCredentials = { serverUrl: '', accessToken: '' };
    if (inboxPolling) {
      inboxPolling.stop();
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
    try {
      const adapter = getIpcFbAuthAdapter();
      // Start login without awaiting — frames and status stream via fb:frame / fb:progress events.
      // The promise resolves when session ends (success or timeout).
      adapter.startLogin()
        .then((result) => updateAgentFbSessionStatus(!!result?.connected || !!result?.valid))
        .catch((err) => {
          console.error('[ipc] fb:login session error:', err.message);
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('fb:progress', {
              stage: 'error',
              status: 'error',
              message: err.message || 'Failed to start Facebook session',
            });
          }
        });
      return { started: true };
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:get-status', async () => {
    try {
      const status = getIpcFbAuthAdapter().getStatus();
      updateAgentFbSessionStatus(!!status?.connected || !!status?.valid);
      return status;
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:post-vehicle', async (_event, { vehicle, listing }) => {
    try {
      const vehicleData = vehicle || listing || {};
      return await getIpcFbPosterAdapter().postVehicle(vehicleData);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:check-inbox', async () => {
    try {
      return await getIpcFbInboxAdapter().checkInbox();
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:send-message', async (_event, { threadId, text, expectedBuyer }) => {
    try {
      return await getIpcFbInboxAdapter().sendMessage(threadId, text, expectedBuyer);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:start-assisted-post', async (_event, { vehicle }) => {
    try {
      return await getIpcFbPosterAdapter().startAssistedPost(vehicle);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:cancel-assisted-post', async () => {
    try {
      return await getIpcFbPosterAdapter().cancelAssistedPost();
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:send-input', async (_event, data) => {
    try {
      // data can be the raw input event, or { input, target } for explicit routing
      const input = data?.input || data;
      const target = data?.target || 'auth';
      if (target === 'assisted') {
        return await getIpcFbPosterAdapter().sendInput(input);
      }
      return await getIpcFbAuthAdapter().sendInput(input);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:delete-session', async () => {
    try {
      return await getIpcFbAuthAdapter().deleteSession();
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:inbox-status', async () => {
    try {
      return await getIpcFbInboxAdapter().getStatus();
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('open-external', async (_event, url) => {
    // Only allow http/https URLs to prevent arbitrary protocol execution
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('feed:fetch-html', async (_event, url) => {
    console.log('[feed:fetch-html] Loading URL in hidden browser:', url);

    const win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    try {
      await win.webContents.session.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await win.loadURL(url);

      let html = '';
      const maxWaitMs = 30000;
      const pollIntervalMs = 2000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));

        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
        await new Promise((r) => setTimeout(r, 1000));

        html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');

        const hasChallenge = html.includes('Client Challenge') || html.includes('Enter the characters');
        const hasListings =
          html.includes('listingTitle') ||
          html.includes('car-blade') ||
          html.includes('listing-row') ||
          html.includes('__NEXT_DATA__') ||
          html.includes('carYear');

        if (!hasChallenge && hasListings) {
          console.log('[feed:fetch-html] Content loaded successfully, length:', html.length);
          break;
        }

        console.log('[feed:fetch-html] Waiting for content... elapsed:', Date.now() - startTime, 'ms');
      }

      for (let i = 0; i < 10; i += 1) {
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
        await new Promise((r) => setTimeout(r, 1500));

        const newHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        if (newHtml.length === html.length) break;
        html = newHtml;
      }

      html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
      console.log('[feed:fetch-html] Final HTML length:', html.length);
      return { success: true, html };
    } catch (error) {
      console.error('[feed:fetch-html] Error:', error.message);
      return { success: false, error: error.message, html: '' };
    } finally {
      win.destroy();
    }
  });
}

async function cleanupAdapters() {
  console.log('[ipc] Cleaning up adapters before quit...');
  const destroyTasks = [];
  if (ipcFbAuthAdapter && typeof ipcFbAuthAdapter.destroy === 'function') {
    destroyTasks.push(ipcFbAuthAdapter.destroy().catch(() => {}));
  }
  if (ipcFbPosterAdapter && typeof ipcFbPosterAdapter.destroy === 'function') {
    destroyTasks.push(ipcFbPosterAdapter.destroy().catch(() => {}));
  }
  if (ipcFbInboxAdapter && typeof ipcFbInboxAdapter.destroy === 'function') {
    destroyTasks.push(ipcFbInboxAdapter.destroy().catch(() => {}));
  }
  if (fbPosterAdapter && fbPosterAdapter !== ipcFbPosterAdapter && typeof fbPosterAdapter.destroy === 'function') {
    destroyTasks.push(fbPosterAdapter.destroy().catch(() => {}));
  }
  if (fbInboxAdapter && fbInboxAdapter !== ipcFbInboxAdapter && typeof fbInboxAdapter.destroy === 'function') {
    destroyTasks.push(fbInboxAdapter.destroy().catch(() => {}));
  }
  if (fbAuthAdapter && fbAuthAdapter !== ipcFbAuthAdapter && typeof fbAuthAdapter.destroy === 'function') {
    destroyTasks.push(fbAuthAdapter.destroy().catch(() => {}));
  }
  if (inboxPolling) {
    inboxPolling.stop();
  }
  if (agentClient) {
    agentClient.disconnect();
  }
  await Promise.allSettled(destroyTasks);
  console.log('[ipc] Adapter cleanup complete');
}

module.exports = { registerIpcHandlers, cleanupAdapters };
