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
let feedAutoSync = null;
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
      apiUrl: agentCredentials.serverUrl,
      authToken: agentCredentials.accessToken,
    });
  }
  if (typeof ipcFbPosterAdapter.setApiCredentials === 'function') {
    ipcFbPosterAdapter.setApiCredentials(agentCredentials.serverUrl, agentCredentials.accessToken);
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

const FEED_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FEED_FETCH_MAX_WAIT_MS = 30000;
const FEED_FETCH_POLL_INTERVAL_MS = 2000;
const FEED_FETCH_SCROLL_SETTLE_MS = 1000;
const FEED_FETCH_EXTRA_SCROLLS = 10;
const FEED_FETCH_EXTRA_SCROLL_DELAY_MS = 1500;
const FEED_FETCH_PAGE_DELAY_MS = 2000;
const FEED_FETCH_MAX_PAGES = 50;
const FEED_FETCH_PAGINATION_JS = `
  (function() {
    var maxPage = 1;
    // Strategy 1: Cars.com Phoenix LiveView pagination links (id="pagination-direct-link-N")
    document.querySelectorAll('a[id^="pagination-direct-link-"]').forEach(function(a) {
      var m = a.id.match(/pagination-direct-link-(\\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    // Strategy 2: phx-value-page attributes (Phoenix LiveView)
    document.querySelectorAll('[phx-value-page]').forEach(function(el) {
      var num = parseInt(el.getAttribute('phx-value-page'), 10);
      if (!isNaN(num)) maxPage = Math.max(maxPage, num);
    });
    // Strategy 3: Any href with page= parameter
    document.querySelectorAll('a[href*="page="]').forEach(function(a) {
      var m = a.href.match(/[?&]page=(\\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    // Strategy 4: Pagination list items with just numbers (avoid nav menus)
    document.querySelectorAll('.sds-pagination__item, .pagination li').forEach(function(el) {
      var text = el.textContent.trim();
      if (text.length <= 3) {
        var num = parseInt(text, 10);
        if (!isNaN(num) && num > 0) maxPage = Math.max(maxPage, num);
      }
    });
    return maxPage;
  })()
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasFeedListings(html) {
  return (
    // CarGurus markers
    html.includes('listingTitle') ||
    html.includes('carYear') ||
    // Cars.com markers
    html.includes('vehicle-card') ||
    html.includes('shop-srp-listings') ||
    // Generic markers
    html.includes('car-blade') ||
    html.includes('listing-row') ||
    html.includes('__NEXT_DATA__') ||
    // JSON-LD with vehicle data (not just any ld+json — must mention vehicle/auto)
    (html.includes('application/ld+json') && (html.includes('Vehicle') || html.includes('AutoDealer')))
  );
}

async function collectFeedHtml(win, label) {
  let html = '';
  const startTime = Date.now();

  while (Date.now() - startTime < FEED_FETCH_MAX_WAIT_MS) {
    await delay(FEED_FETCH_POLL_INTERVAL_MS);

    await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
    await delay(FEED_FETCH_SCROLL_SETTLE_MS);

    html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');

    const hasChallenge = html.includes('Client Challenge') || html.includes('Enter the characters');
    if (!hasChallenge && hasFeedListings(html)) {
      console.log('[feed:fetch-html] Content loaded successfully for', label, 'length:', html.length);
      break;
    }

    console.log('[feed:fetch-html] Waiting for content for', label, 'elapsed:', Date.now() - startTime, 'ms');
  }

  for (let i = 0; i < FEED_FETCH_EXTRA_SCROLLS; i += 1) {
    await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
    await delay(FEED_FETCH_EXTRA_SCROLL_DELAY_MS);

    const newHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    if (newHtml.length === html.length) break;
    html = newHtml;
  }

  return win.webContents.executeJavaScript('document.documentElement.outerHTML');
}

async function detectFeedPageCount(win) {
  try {
    const pageCount = await win.webContents.executeJavaScript(FEED_FETCH_PAGINATION_JS);
    const parsed = Number.parseInt(String(pageCount), 10);
    if (!Number.isFinite(parsed) || parsed < 2) return 1;
    return Math.min(parsed, FEED_FETCH_MAX_PAGES);
  } catch (error) {
    console.warn('[feed:fetch-html] Pagination detection failed:', error.message);
    return 1;
  }
}

function buildPaginatedUrl(baseUrl, page) {
  const nextUrl = new URL(baseUrl);
  nextUrl.searchParams.set('page', String(page));
  return nextUrl.toString();
}

function sendFeedSyncProgress(data) {
  const mainWin = getMainWindow();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('feed:sync-progress', data);
  }
}

async function emitFeedSyncProgress(onProgress, data) {
  if (typeof onProgress !== 'function') return;
  try {
    await onProgress(data);
  } catch (error) {
    console.warn('[feed:fetch-html] Progress callback failed:', error.message);
  }
}

async function fetchFeedHtmlWithBrowser(url, options = {}) {
  const { onProgress = sendFeedSyncProgress } = options;

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
    await win.webContents.session.setUserAgent(FEED_FETCH_UA);
    await win.loadURL(url);

    const collectedPages = [];
    let partialError = null;
    let html = await collectFeedHtml(win, 'page 1');
    collectedPages.push(html);

    const isCarsCom = typeof url === 'string' && url.toLowerCase().includes('cars.com');
    const totalPages = isCarsCom ? await detectFeedPageCount(win) : 1;
    await emitFeedSyncProgress(onProgress, { page: 1, totalPages });

    if (isCarsCom) {
      console.log('[feed:fetch-html] Detected Cars.com page count:', totalPages);

      if (totalPages > 1) {
        const baseUrl = win.webContents.getURL() || url;

        for (let page = 2; page <= totalPages; page += 1) {
          await delay(FEED_FETCH_PAGE_DELAY_MS);
          await emitFeedSyncProgress(onProgress, { page, totalPages });

          const pageUrl = buildPaginatedUrl(baseUrl, page);
          console.log('[feed:fetch-html] Loading paginated URL:', pageUrl);

          try {
            await win.loadURL(pageUrl);
            html = await collectFeedHtml(win, `page ${page}`);
            collectedPages.push(html);
          } catch (error) {
            partialError = `Failed to load page ${page}: ${error.message}`;
            console.error('[feed:fetch-html] Pagination stopped early:', partialError);
            break;
          }
        }
      }
    }

    html = collectedPages.filter(Boolean).join('\n');
    console.log('[feed:fetch-html] Final HTML length:', html.length);
    return partialError
      ? { success: true, html, partial: true, error: partialError }
      : { success: true, html };
  } catch (error) {
    console.error('[feed:fetch-html] Error:', error.message);
    return { success: false, error: error.message, html: '' };
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

function ensureAgentInfrastructure() {
  if (fbPosterAdapter && typeof fbPosterAdapter.setApiCredentials === 'function') {
    fbPosterAdapter.setApiCredentials(agentCredentials.serverUrl, agentCredentials.accessToken);
  }

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

    fbPosterAdapter = fbPosterAdapter || new FbPosterAdapter({
      dataDir: DATA_DIR,
      mainWindow: getMainWindow(),
      apiUrl: agentCredentials.serverUrl,
      authToken: agentCredentials.accessToken,
    });
    if (typeof fbPosterAdapter.setApiCredentials === 'function') {
      fbPosterAdapter.setApiCredentials(agentCredentials.serverUrl, agentCredentials.accessToken);
    }
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
    const nextServerUrl = serverUrl || agentCredentials.serverUrl;
    const nextAccessToken = accessToken || agentCredentials.accessToken;
    agentCredentials = { serverUrl: nextServerUrl, accessToken: nextAccessToken };
    ensureAgentInfrastructure();
    if (ipcFbPosterAdapter && typeof ipcFbPosterAdapter.setApiCredentials === 'function') {
      ipcFbPosterAdapter.setApiCredentials(nextServerUrl, nextAccessToken);
    }
    if (fbPosterAdapter && typeof fbPosterAdapter.setApiCredentials === 'function') {
      fbPosterAdapter.setApiCredentials(nextServerUrl, nextAccessToken);
    }
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

    if (!feedAutoSync) {
      const { FeedAutoSync } = require('./feed-auto-sync');
      feedAutoSync = new FeedAutoSync();
    }
    feedAutoSync.start(nextServerUrl, nextAccessToken);

    return { connected: true, ...agentClient.getStatus() };
  });

  ipcMain.handle('agent:logout', async () => {
    if (agentClient) {
      agentClient.disconnect();
      updateAgentFbSessionStatus(false);
    }
    agentCredentials = { serverUrl: '', accessToken: '' };
    if (ipcFbPosterAdapter && typeof ipcFbPosterAdapter.setApiCredentials === 'function') {
      ipcFbPosterAdapter.setApiCredentials('', '');
    }
    if (fbPosterAdapter && typeof fbPosterAdapter.setApiCredentials === 'function') {
      fbPosterAdapter.setApiCredentials('', '');
    }
    if (inboxPolling) {
      inboxPolling.stop();
    }
    if (feedAutoSync) {
      feedAutoSync.stop();
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

  ipcMain.handle('fb:update-listing', async (_event, { vehicle, listingUrl }) => {
    try {
      return await getIpcFbPosterAdapter().startAssistedUpdate(vehicle, listingUrl);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:delist-vehicle', async (_event, { listingUrl }) => {
    try {
      return await getIpcFbPosterAdapter().delistVehicle(listingUrl);
    } catch (error) {
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:renew-listing', async (_event, { listingUrl }) => {
    try {
      return await getIpcFbPosterAdapter().renewListing(listingUrl);
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
    // Mark as manual sync so auto-sync doesn't overlap
    try { const { markManualSync } = require('./feed-auto-sync'); markManualSync(); } catch {}
    return fetchFeedHtmlWithBrowser(url);
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
  if (feedAutoSync) {
    feedAutoSync.stop();
  }
  if (agentClient) {
    agentClient.disconnect();
  }
  await Promise.allSettled(destroyTasks);
  console.log('[ipc] Adapter cleanup complete');
}

module.exports = { registerIpcHandlers, cleanupAdapters, fetchFeedHtmlWithBrowser };
