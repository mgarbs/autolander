'use strict';

const { getMainWindow } = require('./window-manager');
const { fetchFeedHtmlWithBrowser } = require('./ipc-handlers');

const AUTO_SYNC_INITIAL_DELAY_MS = 60_000;
const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_SYNC_SKIP_IF_RECENT_MS = 5 * 60 * 1000; // Skip if synced in last 5 min

// Shared flag — manual sync sets this so auto-sync knows to skip
let lastManualSyncAt = 0;
function markManualSync() { lastManualSyncAt = Date.now(); }
function recentManualSync() { return (Date.now() - lastManualSyncAt) < AUTO_SYNC_SKIP_IF_RECENT_MS; }
const BROWSER_FEED_TYPES = new Set(['CARSCOM', 'CARGURUS']);

function isBrowserProtectedFeed(feed) {
  const feedUrl = typeof feed?.feedUrl === 'string' ? feed.feedUrl.toLowerCase() : '';
  return Boolean(
    feed?.enabled && (
      BROWSER_FEED_TYPES.has(feed.feedType) ||
      feedUrl.includes('cars.com') ||
      feedUrl.includes('cargurus.com')
    )
  );
}

function getFeedName(feed) {
  return feed?.name || feed?.feedUrl || `Feed ${feed?.id || 'unknown'}`;
}

class FeedAutoSync {
  constructor() {
    this.serverUrl = '';
    this.accessToken = '';
    this.intervalId = null;
    this.initialTimeoutId = null;
    this.syncing = false;
    this.runToken = 0;
  }

  start(serverUrl, accessToken) {
    this.stop();

    if (!serverUrl || !accessToken) {
      console.log('[feed-auto-sync] Missing credentials, not starting');
      return;
    }

    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
    this.runToken += 1;
    const activeRunToken = this.runToken;

    this.initialTimeoutId = setTimeout(() => {
      this.runSyncCycle(activeRunToken).catch((error) => {
        console.error('[feed-auto-sync] Initial cycle failed:', error.message);
      });
    }, AUTO_SYNC_INITIAL_DELAY_MS);

    this.intervalId = setInterval(() => {
      this.runSyncCycle(activeRunToken).catch((error) => {
        console.error('[feed-auto-sync] Scheduled cycle failed:', error.message);
      });
    }, AUTO_SYNC_INTERVAL_MS);

    console.log('[feed-auto-sync] Started - initial sync in 60s, then every 6h');
  }

  stop() {
    this.runToken += 1;

    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.serverUrl = '';
    this.accessToken = '';
    console.log('[feed-auto-sync] Stopped');
  }

  isActive(runToken) {
    return runToken === this.runToken && Boolean(this.serverUrl) && Boolean(this.accessToken);
  }

  buildApiUrl(pathname) {
    return new URL(pathname, this.serverUrl).toString();
  }

  getAuthHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async runSyncCycle(runToken = this.runToken) {
    if (this.syncing) {
      console.log('[feed-auto-sync] Already syncing, skipping cycle');
      return;
    }

    if (!this.isActive(runToken)) {
      console.log('[feed-auto-sync] No active credentials, skipping cycle');
      return;
    }

    if (recentManualSync()) {
      console.log('[feed-auto-sync] Manual sync was recent, skipping cycle');
      return;
    }

    this.syncing = true;

    try {
      const feeds = await this.fetchFeeds();
      if (!this.isActive(runToken)) return;

      const browserFeeds = feeds.filter(isBrowserProtectedFeed);
      this.sendEvent('auto-sync-start', { feedCount: browserFeeds.length });

      if (browserFeeds.length === 0) {
        console.log('[feed-auto-sync] No browser-fetch feeds found');
        this.sendEvent('auto-sync-complete', {
          feedCount: 0,
          totalVehicles: 0,
          totalAdded: 0,
          totalUpdated: 0,
        });
        return;
      }

      console.log(`[feed-auto-sync] Syncing ${browserFeeds.length} browser-protected feeds`);

      let totalVehicles = 0;
      let totalAdded = 0;
      let totalUpdated = 0;

      for (let index = 0; index < browserFeeds.length; index += 1) {
        if (!this.isActive(runToken)) {
          console.log('[feed-auto-sync] Sync stopped mid-cycle');
          return;
        }

        const feed = browserFeeds[index];
        const feedName = getFeedName(feed);
        const feedIndex = index + 1;
        const feedCount = browserFeeds.length;

        this.sendEvent('auto-sync-feed-start', {
          feedName,
          feedIndex,
          feedCount,
          feedUrl: feed.feedUrl,
        });

        try {
          const result = await this.syncOneFeed(feed, {
            runToken,
            feedName,
            feedIndex,
            feedCount,
          });

          totalVehicles += result.vehiclesFound || 0;
          totalAdded += result.vehiclesAdded || 0;
          totalUpdated += result.vehiclesUpdated || 0;

          this.sendEvent('auto-sync-feed-done', {
            feedName,
            feedIndex,
            feedCount,
            vehiclesFound: result.vehiclesFound || 0,
            vehiclesAdded: result.vehiclesAdded || 0,
            vehiclesUpdated: result.vehiclesUpdated || 0,
          });

          console.log(
            `[feed-auto-sync] Feed ${feed.id} synced: found=${result.vehiclesFound || 0}, added=${result.vehiclesAdded || 0}, updated=${result.vehiclesUpdated || 0}`
          );
        } catch (error) {
          console.error(`[feed-auto-sync] Feed ${feed.id} failed: ${error.message}`);
          this.sendEvent('auto-sync-feed-error', {
            feedName,
            feedIndex,
            feedCount,
            error: error.message,
          });
        }
      }

      if (!this.isActive(runToken)) return;

      this.sendEvent('auto-sync-complete', {
        feedCount: browserFeeds.length,
        totalVehicles,
        totalAdded,
        totalUpdated,
      });
    } catch (error) {
      if (!this.isActive(runToken)) return;
      console.error('[feed-auto-sync] Cycle failed:', error.message);
      this.sendEvent('auto-sync-error', { error: error.message });
    } finally {
      this.syncing = false;
    }
  }

  async fetchFeeds() {
    const response = await fetch(this.buildApiUrl('/api/feeds'), {
      headers: this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch feeds: HTTP ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.feeds) ? data.feeds : [];
  }

  async syncOneFeed(feed, { runToken, feedName }) {
    const fetchResult = await fetchFeedHtmlWithBrowser(feed.feedUrl, {
      onProgress: ({ page, totalPages }) => {
        if (!this.isActive(runToken)) return;
        this.sendEvent('auto-sync-page', { feedName, page, totalPages });
      },
    });

    if (!fetchResult.success || !fetchResult.html) {
      throw new Error(fetchResult.error || 'Browser fetch failed');
    }

    if (!this.isActive(runToken)) {
      throw new Error('Auto-sync stopped');
    }

    const response = await fetch(this.buildApiUrl(`/api/feeds/${feed.id}/sync-html`), {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ html: fetchResult.html }),
    });

    if (!response.ok) {
      let errorDetail = '';
      try {
        errorDetail = await response.text();
      } catch (_) {
        errorDetail = '';
      }
      throw new Error(
        errorDetail
          ? `Sync failed: HTTP ${response.status} ${errorDetail}`.trim()
          : `Sync failed: HTTP ${response.status}`
      );
    }

    return response.json();
  }

  sendEvent(type, data) {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('feed:auto-sync', { type, ...data });
    }
  }
}

module.exports = { FeedAutoSync, markManualSync };
