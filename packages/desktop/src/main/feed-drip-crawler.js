'use strict';

/**
 * Feed Drip Crawler — "sucker fish" background photo fetcher.
 *
 * Instead of batch-loading all search pages (which triggers anti-bot),
 * this crawls one vehicle detail page at a time with generous delays.
 * Vehicles appear with photos gradually as the crawler works through them.
 *
 * Flow:
 *   1. Query API for a small batch of vehicles missing photos
 *   2. For each vehicle, load its detail page directly via dealerUrl
 *   3. Scrape photos, save immediately via API
 *   4. Wait 10-20s before the next vehicle
 *   5. When batch is done, wait 2 min and check for more
 *   6. When all vehicles have photos, idle and check every 10 min
 */

const { BrowserWindow } = require('electron');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Timing — slow and steady to avoid rate limits
const BETWEEN_VEHICLES_MS = 15_000;       // 15s between each vehicle
const BETWEEN_BATCHES_MS = 2 * 60_000;    // 2 min between batches
const IDLE_CHECK_MS = 10 * 60_000;        // 10 min when nothing to do
const PAGE_LOAD_TIMEOUT_MS = 30_000;      // 30s to load a detail page
const SCROLL_DELAY_MS = 800;
const SCROLL_PASSES = 6;
const BATCH_SIZE = 5;                     // vehicles per batch

const DETAIL_IMAGES_JS = `
  (function() {
    var urls = [];
    var seen = {};
    var imgs = document.querySelectorAll('img[src*="cstatic-images.com"]');
    for (var i = 0; i < imgs.length; i += 1) {
      var src = imgs[i].src || '';
      if (!src) continue;
      if (src.indexOf('dealer_media') !== -1) continue;
      if (src.indexOf('static/app-images') !== -1) continue;
      if (/\\.svg(?:\\?|#|$)/i.test(src)) continue;
      if (seen[src]) continue;
      seen[src] = true;
      urls.push(src);
    }
    return urls;
  })()
`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FeedDripCrawler {
  constructor() {
    this.serverUrl = '';
    this.accessToken = '';
    this.running = false;
    this.stopped = false;
    this.win = null;
    this.stats = { processed: 0, photosFound: 0, failed: 0 };
  }

  start(serverUrl, accessToken) {
    this.stop();

    if (!serverUrl || !accessToken) {
      console.log('[drip-crawler] Missing credentials, not starting');
      return;
    }

    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
    this.stopped = false;
    this.stats = { processed: 0, photosFound: 0, failed: 0 };

    console.log('[drip-crawler] Starting background photo crawler');
    this._runLoop();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this._destroyWindow();
    console.log('[drip-crawler] Stopped');
  }

  _destroyWindow() {
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch (_) {}
    }
    this.win = null;
  }

  _buildApiUrl(pathname) {
    return new URL(pathname, this.serverUrl).toString();
  }

  _authHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async _runLoop() {
    if (this.running) return;
    this.running = true;

    // Initial delay — let the app settle
    await delay(30_000);

    while (!this.stopped) {
      try {
        const vehicles = await this._fetchVehiclesMissingPhotos();

        if (vehicles.length === 0) {
          console.log('[drip-crawler] All vehicles have photos — idling');
          await delay(IDLE_CHECK_MS);
          continue;
        }

        console.log(`[drip-crawler] Found ${vehicles.length} vehicles needing photos`);
        await this._ensureWindow();

        let updated = 0;
        let skipped = 0;

        for (const vehicle of vehicles) {
          if (this.stopped) break;

          const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || vehicle.vin || 'Vehicle';

          try {
            const photos = await this._fetchPhotosForVehicle(vehicle);

            if (photos.length > 0) {
              await this._savePhotos(vehicle.id, photos);
              updated += 1;
              this.stats.photosFound += photos.length;
              console.log(`[drip-crawler] ${name}: ${photos.length} photos saved`);
            } else {
              skipped += 1;
              console.log(`[drip-crawler] ${name}: no photos found on detail page`);
            }
          } catch (error) {
            skipped += 1;
            this.stats.failed += 1;
            console.warn(`[drip-crawler] ${name}: ${error.message}`);
          }

          this.stats.processed += 1;

          // Generous pause between vehicles
          if (!this.stopped) await delay(BETWEEN_VEHICLES_MS);
        }

        this._destroyWindow();

        console.log(
          `[drip-crawler] Batch done: ${updated} updated, ${skipped} skipped — ` +
          `lifetime: ${this.stats.processed} processed, ${this.stats.photosFound} photos, ${this.stats.failed} failed`
        );

        // Wait before next batch
        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      } catch (error) {
        console.error('[drip-crawler] Loop error:', error.message);
        this._destroyWindow();
        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      }
    }

    this._destroyWindow();
    this.running = false;
  }

  async _fetchVehiclesMissingPhotos() {
    const url = this._buildApiUrl(
      `/api/vehicles?missingPhotos=true&status=ACTIVE&limit=${BATCH_SIZE}&offset=0`
    );
    const response = await fetch(url, { headers: this._authHeaders() });

    if (!response.ok) {
      throw new Error(`API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.vehicles) ? data.vehicles : [];
  }

  async _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return;

    this.win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    await this.win.webContents.session.setUserAgent(UA);
  }

  async _fetchPhotosForVehicle(vehicle) {
    if (!vehicle.dealerUrl) {
      throw new Error('No dealer URL');
    }

    // Load the vehicle's detail page directly
    const detailUrl = vehicle.dealerUrl.startsWith('http')
      ? vehicle.dealerUrl
      : `https://www.cars.com${vehicle.dealerUrl}`;

    await this._loadPage(detailUrl);

    // Scroll to trigger lazy-loaded images
    let bestUrls = [];
    for (let pass = 0; pass < SCROLL_PASSES; pass += 1) {
      if (this.stopped) return [];

      await this.win.webContents.executeJavaScript(
        'window.scrollTo(0, document.body.scrollHeight)'
      );
      await delay(SCROLL_DELAY_MS);

      const urls = await this.win.webContents.executeJavaScript(DETAIL_IMAGES_JS);
      const normalized = Array.isArray(urls) ? urls : [];

      if (normalized.length > bestUrls.length) {
        bestUrls = normalized;
      } else if (normalized.length > 0 && normalized.length === bestUrls.length) {
        break; // No new images found, stop scrolling
      }
    }

    return bestUrls;
  }

  async _loadPage(url) {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        await this.win.loadURL(url);
        // Wait for page to be interactive
        await this._waitForPageReady();
        return;
      } catch (error) {
        if (this.stopped) throw new Error('Crawler stopped');
        if (attempt >= maxRetries) throw error;

        const backoff = 5000 * attempt;
        console.warn(
          `[drip-crawler] Page load failed (attempt ${attempt}/${maxRetries}): ${error.message} — retrying in ${backoff}ms`
        );
        await delay(backoff);

        // Recreate window if it was destroyed
        await this._ensureWindow();
      }
    }
  }

  async _waitForPageReady() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < PAGE_LOAD_TIMEOUT_MS) {
      if (this.stopped) throw new Error('Crawler stopped');

      const readyState = await this.win.webContents.executeJavaScript(
        'document.readyState'
      );

      if (readyState === 'complete' || readyState === 'interactive') {
        // Give a moment for dynamic content
        await delay(2000);
        return;
      }

      await delay(1000);
    }

    // Don't throw — page might still have usable content
    console.warn('[drip-crawler] Page load timed out, proceeding anyway');
  }

  async _savePhotos(vehicleId, photos) {
    const response = await fetch(
      this._buildApiUrl(`/api/vehicles/${encodeURIComponent(vehicleId)}/photos`),
      {
        method: 'PUT',
        headers: this._authHeaders(),
        body: JSON.stringify({ photos }),
      }
    );

    if (!response.ok) {
      throw new Error(`Photo save failed: HTTP ${response.status}`);
    }
  }
}

// Singleton
let instance = null;

function startDripCrawler(serverUrl, accessToken) {
  if (!instance) {
    instance = new FeedDripCrawler();
  }
  instance.start(serverUrl, accessToken);
  return instance;
}

function stopDripCrawler() {
  if (instance) {
    instance.stop();
  }
}

module.exports = { FeedDripCrawler, startDripCrawler, stopDripCrawler };
