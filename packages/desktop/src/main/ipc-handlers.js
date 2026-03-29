'use strict';

const path = require('path');
const os = require('os');
const { BrowserWindow, session, shell } = require('electron');
const { getMainWindow } = require('./window-manager');
const { enqueueFeedImageFetch, stopFeedImageFetch } = require('./feed-image-fetcher');

// Worker modules (lazy-loaded)
let agentClient = null;
let commandRouter = null;
let fbPosterAdapter = null;
let fbInboxAdapter = null;
let fbAuthAdapter = null;
let feedAutoSync = null;
let agentCredentials = { serverUrl: '', accessToken: '', userId: '' };
let inboxPolling = null;

const DATA_DIR = path.join(os.homedir(), '.autolander', 'data');
process.env.AUTO_SALES_DATA_DIR = DATA_DIR;

/**
 * Decode a JWT payload without verification (client-side, we trust the token).
 * Extracts the user ID to key FB sessions per-user instead of 'default'.
 */
function getUserIdFromToken(token) {
  if (!token) return '';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.sub || '';
  } catch {
    return '';
  }
}

/**
 * Get the current salesperson ID — the AutoLander user ID, falling back to
 * 'default' only if no user is logged in. This keys FB sessions per-user
 * so multiple users on the same machine each get their own session.
 */
function getSalespersonId() {
  return agentCredentials.userId || 'default';
}

/**
 * Update all adapter instances with a new salespersonId. Called on login
 * when the user changes. Tears down the shared browser for the old user
 * and updates all adapters to point to the new user.
 */
async function updateAdapterSalespersonId(id) {
  // Tear down the shared browser for the previous user (kills Chrome for all modules)
  const oldId = getSalespersonId();
  if (oldId && oldId !== id) {
    const { SharedBrowser } = require('../../lib/shared-browser');
    await SharedBrowser.teardown(oldId).catch(() => {});
  }

  const updates = [];
  if (ipcFbAuthAdapter && typeof ipcFbAuthAdapter.setSalespersonId === 'function') {
    ipcFbAuthAdapter.setSalespersonId(id);
  }
  if (ipcFbPosterAdapter && typeof ipcFbPosterAdapter.setSalespersonId === 'function') {
    updates.push(ipcFbPosterAdapter.setSalespersonId(id));
  }
  if (ipcFbInboxAdapter && typeof ipcFbInboxAdapter.setSalespersonId === 'function') {
    updates.push(ipcFbInboxAdapter.setSalespersonId(id));
  }
  if (fbPosterAdapter && fbPosterAdapter !== ipcFbPosterAdapter && typeof fbPosterAdapter.setSalespersonId === 'function') {
    updates.push(fbPosterAdapter.setSalespersonId(id));
  }
  if (fbInboxAdapter && fbInboxAdapter !== ipcFbInboxAdapter && typeof fbInboxAdapter.setSalespersonId === 'function') {
    updates.push(fbInboxAdapter.setSalespersonId(id));
  }
  if (fbAuthAdapter && fbAuthAdapter !== ipcFbAuthAdapter && typeof fbAuthAdapter.setSalespersonId === 'function') {
    fbAuthAdapter.setSalespersonId(id);
  }
  await Promise.allSettled(updates);
}

let ipcFbAuthAdapter = null;
let ipcFbPosterAdapter = null;
let ipcFbInboxAdapter = null;
const ASSISTED_POST_TERMINAL_STATES = new Set(['success', 'error', 'timeout']);

function getIpcFbAuthAdapter() {
  if (!ipcFbAuthAdapter) {
    const { FbAuthAdapter } = require('./adapters/fb-auth-adapter');
    ipcFbAuthAdapter = new FbAuthAdapter({
      dataDir: DATA_DIR,
      salespersonId: getSalespersonId(),
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
      salespersonId: getSalespersonId(),
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
      salespersonId: getSalespersonId(),
      mainWindow: getMainWindow(),
    });
  }
  ipcFbInboxAdapter.setMainWindow(getMainWindow());
  return ipcFbInboxAdapter;
}

function asErrorResult(error) {
  return { error: error && error.message ? error.message : 'Unknown error' };
}

function isCarsComFeed(feed) {
  const feedUrl = typeof feed?.feedUrl === 'string' ? feed.feedUrl.toLowerCase() : '';
  return feed?.feedType === 'CARSCOM' || feedUrl.includes('cars.com');
}

function sendAgentStatus(status) {
  const win = getMainWindow();
  if (!win) return;
  const fullStatus = { ...status };
  if (inboxPolling) {
    fullStatus.inbox = inboxPolling.getStatus();
  }
  win.webContents.send('agent:status', fullStatus);
  // Backward compatibility for current preload bridge.
  win.webContents.send('agent:status-update', fullStatus);
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
    // First try: calculate from total count (most reliable)
    // Cars.com shows "X matches" and displays 24 per page
    const totalCount = await win.webContents.executeJavaScript(`
      (function() {
        // Look for "X matches" or "X results" text
        var text = document.body.innerText || '';
        var m = text.match(/(\\d+)\\s*match/i) || text.match(/(\\d+)\\s*result/i);
        if (m) return parseInt(m[1], 10);
        // Try data attributes
        var el = document.querySelector('[data-total-count]');
        if (el) return parseInt(el.getAttribute('data-total-count'), 10);
        return 0;
      })()
    `);
    if (totalCount > 24) {
      const pages = Math.ceil(totalCount / 24);
      console.log('[feed:fetch-html] Calculated page count from total:', totalCount, '→', pages, 'pages');
      return Math.min(pages, FEED_FETCH_MAX_PAGES);
    }

    // Fallback: detect from pagination DOM elements
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

  const partition = `feed-html-${Date.now()}`;
  const ses = session.fromPartition(partition, { cache: false });
  await ses.setUserAgent(FEED_FETCH_UA);

  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
    },
  });

  try {
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

/**
 * Fetch photos for vehicles using a hidden BrowserWindow.
 * Much faster than the drip crawler (net module) because JS executes
 * and .primary-grid images load properly.
 *
 * @param {Array<{id: string, dealerUrl: string}>} vehicles
 * @param {string} serverUrl
 * @param {string} accessToken
 */
async function fetchPhotosWithBrowser(vehicles, serverUrl, accessToken) {
  if (!vehicles || vehicles.length === 0) return { fetched: 0 };

  const partition = `photo-fetch-${Date.now()}`;
  const ses = session.fromPartition(partition, { cache: false });
  await ses.setUserAgent(FEED_FETCH_UA);

  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
  });

  let fetched = 0;
  try {
    for (const vehicle of vehicles) {
      if (!vehicle.dealerUrl) continue;
      try {
        await win.loadURL(vehicle.dealerUrl);
        // Wait for JS to render the gallery
        await delay(3000);
        // Scroll to trigger lazy loading
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
        await delay(1000);
        await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
        await delay(500);

        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');

        // Extract photos from .primary-grid only
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        const seen = new Set();
        const photos = [];

        $('.primary-grid img').each((_, el) => {
          const node = $(el);
          const src = node.attr('src') || node.attr('data-src') || node.attr('data-original') || node.attr('data-lazy-src');
          if (!src || !src.includes('cstatic-images.com') || !src.includes('/in/v2/')) return;
          const upgraded = src.replace(/\/(?:small|medium|large|xlarge)\/in\/v2\//i, '/xxlarge/in/v2/');
          if (seen.has(upgraded)) return;
          seen.add(upgraded);
          photos.push(upgraded);
        });

        if (photos.length === 0) continue;

        // Sample 20 from beginning/middle/end
        let sampled = photos;
        if (photos.length > 20) {
          sampled = [];
          const step = photos.length / 20;
          for (let i = 0; i < 20; i++) {
            sampled.push(photos[Math.floor(i * step)]);
          }
        }

        // Save to API
        const url = new URL(`/api/vehicles/${vehicle.id}`, serverUrl).toString();
        await fetch(url, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ photos: sampled }),
        });

        fetched++;
        console.log(`[photo-fetch] ${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}: ${sampled.length} photos`);
      } catch (err) {
        console.warn(`[photo-fetch] Failed for ${vehicle.dealerUrl}: ${err.message}`);
      }

      // Small delay between vehicles
      await delay(1500);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }

  console.log(`[photo-fetch] Done: ${fetched}/${vehicles.length} vehicles got photos`);
  return { fetched };
}

function ensureAgentInfrastructure() {
  const spId = getSalespersonId();

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
      salespersonId: spId,
      mainWindow: getMainWindow(),
      apiUrl: agentCredentials.serverUrl,
      authToken: agentCredentials.accessToken,
    });
    if (typeof fbPosterAdapter.setApiCredentials === 'function') {
      fbPosterAdapter.setApiCredentials(agentCredentials.serverUrl, agentCredentials.accessToken);
    }
    fbInboxAdapter = fbInboxAdapter || new FbInboxAdapter({ dataDir: DATA_DIR, salespersonId: spId, mainWindow: getMainWindow() });
    fbAuthAdapter = fbAuthAdapter || new FbAuthAdapter({ dataDir: DATA_DIR, salespersonId: spId, mainWindow: getMainWindow() });
    commandRouter = new CommandRouter({
      agentClient,
      fbPosterAdapter,
      fbInboxAdapter,
      fbAuthAdapter,
    });
  }
}

/**
 * Validate the local FB session for the current user.
 * Returns true only if the session file exists on THIS device with valid cookies.
 * Does not trust any cloud flag — checks local disk reality.
 */
function validateLocalFbSession() {
  try {
    const { FbSessionManager } = require('../../lib/fb-session-manager');
    const manager = new FbSessionManager(getSalespersonId());
    const status = manager.getStatus();
    return !!(status && status.connected);
  } catch {
    return false;
  }
}

function updateAgentFbSessionStatus(valid) {
  if (!agentClient) return;
  agentClient.setFbSessionValid(!!valid);
}

function ensureInboxPolling() {
  if (inboxPolling) return inboxPolling;
  const { InboxListener } = require('../worker/inbox-listener');
  inboxPolling = new InboxListener({ fbInboxAdapter: getIpcFbInboxAdapter() });
  inboxPolling.on('poll-complete', () => {
    if (agentClient) sendAgentStatus(agentClient.getStatus());
  });
  console.log('[ipc] InboxPolling created');
  return inboxPolling;
}

let _postResumeTimer = null;

function pauseInboxPollingForAssistedPost() {
  if (!inboxPolling) return;
  // Cancel any pending resume timer (user is posting again)
  if (_postResumeTimer) {
    clearTimeout(_postResumeTimer);
    _postResumeTimer = null;
  }
  inboxPolling.pause();
  if (agentClient) sendAgentStatus(agentClient.getStatus());
}

function resumeInboxPollingAfterAssistedPost() {
  if (!inboxPolling) return;
  // Don't resume if the user explicitly paused via the toggle
  if (inboxPolling._userPaused) {
    console.log('[ipc] Post complete but autoresponder is user-paused, not resuming');
    return;
  }
  // Wait 5 minutes before resuming — gives the user time to post another vehicle
  // without the autoresponder kicking in between posts
  if (_postResumeTimer) clearTimeout(_postResumeTimer);
  _postResumeTimer = setTimeout(() => {
    _postResumeTimer = null;
    if (!inboxPolling || inboxPolling._userPaused) return;
    console.log('[ipc] 5 min since last post — resuming autoresponder');
    inboxPolling.resume();
    if (agentClient) sendAgentStatus(agentClient.getStatus());
  }, 5 * 60 * 1000);
  console.log('[ipc] Post complete — autoresponder will resume in 5 minutes');
}

function attachAssistedSessionPollingResume(adapter) {
  const session = adapter?.assistedSession;
  if (!session) return false;
  if (session._pollingResumeHookAttached) return true;

  const forwardStatus = session.onStatusChange;
  session.onStatusChange = (status) => {
    forwardStatus?.(status);
    if (ASSISTED_POST_TERMINAL_STATES.has(status?.state)) {
      resumeInboxPollingAfterAssistedPost();
    }
  };
  session._pollingResumeHookAttached = true;
  return true;
}

function registerIpcHandlers(ipcMain) {
  // --- Agent connection ---
  ipcMain.handle('agent:login', async (_event, { serverUrl, accessToken }) => {
    console.log('[ipc] agent:login called, serverUrl:', serverUrl);
    const nextServerUrl = serverUrl || agentCredentials.serverUrl;
    const nextAccessToken = accessToken || agentCredentials.accessToken;
    const nextUserId = getUserIdFromToken(nextAccessToken);
    const userChanged = nextUserId && nextUserId !== agentCredentials.userId;
    agentCredentials = { serverUrl: nextServerUrl, accessToken: nextAccessToken, userId: nextUserId };

    if (nextUserId) {
      console.log('[ipc] User ID from token:', nextUserId);
    }

    ensureAgentInfrastructure();

    // If the user changed, update all adapters so they use the correct
    // per-user FB session and Chrome profile directory.
    if (userChanged) {
      console.log('[ipc] User changed — switching FB sessions to', nextUserId);
      await updateAdapterSalespersonId(nextUserId);
    }
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
    // Validate local FB session — check THIS device's actual cookie file,
    // not a cloud flag. This prevents "looks connected" when the session
    // was created on a different device.
    const localFbValid = validateLocalFbSession();
    updateAgentFbSessionStatus(localFbValid);
    console.log('[ipc] Local FB session validation:', localFbValid ? 'valid' : 'not connected on this device');

    sendAgentStatus(agentClient.getStatus());

    // Start inbox polling for auto-reply — but ONLY if we have a valid
    // local FB session. Launching Chrome to poll an inbox we can't access
    // is pointless and causes a confusing "Failed to launch browser" error
    // that overlaps with the FB login flow.
    if (localFbValid) {
      try {
        const poller = ensureInboxPolling();
        poller.start(getIpcFbInboxAdapter(), {
          serverUrl: nextServerUrl,
          accessToken: nextAccessToken,
        });
        console.log('[ipc] InboxPolling started');
      } catch (err) {
        console.error('[ipc] InboxPolling start error:', err.message);
      }
    } else {
      console.log('[ipc] InboxPolling deferred — no local FB session yet');
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
    agentCredentials = { serverUrl: '', accessToken: '', userId: '' };
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
    stopFeedImageFetch();
    return { disconnected: true };
  });

  ipcMain.handle('agent:get-status', () => {
    if (!agentClient) return { connected: false, fbSessionValid: false };
    const status = agentClient.getStatus();
    if (inboxPolling) {
      status.inbox = inboxPolling.getStatus();
    }
    return status;
  });

  ipcMain.handle('autoresponder:pause', () => {
    if (!inboxPolling) return { paused: false };
    inboxPolling._userPaused = true;
    inboxPolling.pause();
    return { paused: true };
  });

  ipcMain.handle('autoresponder:resume', () => {
    if (!inboxPolling) return { paused: false };
    inboxPolling._userPaused = false;
    inboxPolling.resume();
    return { paused: false };
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
      // Register a callback that fires when FB login ACTUALLY succeeds
      // (cookies saved to disk). startLogin() resolves when the browser opens,
      // NOT when the user finishes logging in — so .then() is too early.
      adapter.onLoginSuccess = () => {
        console.log('[ipc] FB login success callback fired');
        const valid = validateLocalFbSession();
        updateAgentFbSessionStatus(valid);
        if (valid && agentCredentials.serverUrl && agentCredentials.accessToken && !inboxPolling?._active) {
          try {
            const poller = ensureInboxPolling();
            poller.start(getIpcFbInboxAdapter(), {
              serverUrl: agentCredentials.serverUrl,
              accessToken: agentCredentials.accessToken,
            });
            console.log('[ipc] InboxPolling started after FB login');
          } catch (err) {
            console.error('[ipc] InboxPolling start error:', err.message);
          }
        }
      };

      // Small delay to let any previous session's Chrome fully exit
      await new Promise((r) => setTimeout(r, 1500));
      adapter.startLogin()
        .catch((err) => {
          console.error('[ipc] fb:login session error:', err.message);
          // Don't show transient "Failed to launch browser" errors —
          // these happen when a previous Chrome is still shutting down.
          // Only surface real auth failures to the user.
          if (err.message && err.message.includes('Failed to launch the browser')) {
            console.warn('[ipc] Transient browser launch error — suppressed from UI');
            return;
          }
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
    const adapter = getIpcFbPosterAdapter();
    try {
      pauseInboxPollingForAssistedPost();
      const result = await adapter.startAssistedPost(vehicle);
      if (!attachAssistedSessionPollingResume(adapter)) {
        resumeInboxPollingAfterAssistedPost();
      }
      return result;
    } catch (error) {
      resumeInboxPollingAfterAssistedPost();
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:cancel-assisted-post', async () => {
    try {
      const result = await getIpcFbPosterAdapter().cancelAssistedPost();
      resumeInboxPollingAfterAssistedPost();
      return result;
    } catch (error) {
      resumeInboxPollingAfterAssistedPost();
      return asErrorResult(error);
    }
  });

  ipcMain.handle('fb:update-listing', async (_event, { vehicle, listingUrl }) => {
    const adapter = getIpcFbPosterAdapter();
    try {
      pauseInboxPollingForAssistedPost();
      const result = await adapter.startAssistedUpdate(vehicle, listingUrl);
      if (!attachAssistedSessionPollingResume(adapter)) {
        resumeInboxPollingAfterAssistedPost();
      }
      return result;
    } catch (error) {
      resumeInboxPollingAfterAssistedPost();
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

  ipcMain.handle('feed:fetch-images', async (_event, feed) => {
    if (!agentCredentials.serverUrl || !agentCredentials.accessToken) {
      return { queued: false, error: 'Missing API credentials' };
    }

    if (!isCarsComFeed(feed)) {
      return { queued: false, skipped: true, reason: 'unsupported-feed' };
    }

    enqueueFeedImageFetch(agentCredentials.serverUrl, agentCredentials.accessToken, feed)
      .catch((error) => {
        console.error('[feed-image-fetcher] Error:', error.message);
      });

    return { queued: true };
  });

  ipcMain.handle('feed:stop-image-fetch', async (_event, feedId) => {
    stopFeedImageFetch(feedId || undefined);
    return { stopped: true };
  });
}

async function cleanupAdapters() {
  console.log('[ipc] Cleaning up adapters before quit...');
  const destroyTasks = [];
  if (ipcFbAuthAdapter && typeof ipcFbAuthAdapter.destroy === 'function') {
    destroyTasks.push(Promise.resolve(ipcFbAuthAdapter.destroy()).catch(() => {}));
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
    destroyTasks.push(Promise.resolve(fbAuthAdapter.destroy()).catch(() => {}));
  }
  if (inboxPolling) {
    inboxPolling.stop();
  }
  if (feedAutoSync) {
    feedAutoSync.stop();
  }
  stopFeedImageFetch();
  if (agentClient) {
    agentClient.disconnect();
  }
  await Promise.allSettled(destroyTasks);

  // Kill all shared Chrome instances
  const { SharedBrowser } = require('../../lib/shared-browser');
  await SharedBrowser.teardownAll().catch(() => {});

  console.log('[ipc] Adapter cleanup complete');
}

module.exports = { registerIpcHandlers, cleanupAdapters, fetchFeedHtmlWithBrowser, fetchPhotosWithBrowser };
