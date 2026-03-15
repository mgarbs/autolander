'use strict';

/**
 * Feed Drip Crawler — "sucker fish" background photo fetcher.
 *
 * Fetches vehicle detail pages via plain HTTP + cheerio (no browser needed).
 * Cars.com serves full image URLs in server-rendered HTML, so we don't need
 * Electron BrowserWindow or Puppeteer — just fetch and parse.
 *
 * Flow:
 *   1. Query API for a small batch of vehicles missing photos
 *   2. For each vehicle, HTTP-fetch its detail page via dealerUrl
 *   3. Parse HTML with cheerio to extract photo URLs
 *   4. Save photos immediately via API
 *   5. Wait between vehicles to avoid rate limits
 *   6. When batch is done, wait and check for more
 *   7. When all vehicles have photos, idle and check periodically
 */

const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Timing — slow and steady to avoid rate limits
const BETWEEN_VEHICLES_MS = 5_000;        // 5s between each vehicle (faster since no browser)
const BETWEEN_BATCHES_MS = 2 * 60_000;    // 2 min between batches
const IDLE_CHECK_MS = 10 * 60_000;        // 10 min when nothing to do
const FETCH_TIMEOUT_MS = 20_000;          // 20s per HTTP request
const BATCH_SIZE = 10;                    // vehicles per batch (can be bigger without browser)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractPhotos(html) {
  const $ = cheerio.load(html);
  const urls = [];
  const seen = new Set();

  $('img[src*="cstatic-images.com"]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src) return;
    if (src.includes('dealer_media')) return;
    if (src.includes('static/app-images')) return;
    if (/\.svg(?:\?|#|$)/i.test(src)) return;
    if (seen.has(src)) return;
    seen.add(src);
    urls.push(src);
  });

  return urls;
}

class FeedDripCrawler {
  constructor() {
    this.serverUrl = '';
    this.accessToken = '';
    this.running = false;
    this.stopped = false;
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

    console.log('[drip-crawler] Starting background photo crawler (HTTP mode)');
    this._runLoop();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    console.log('[drip-crawler] Stopped');
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
              console.log(`[drip-crawler] ${name}: no photos found`);
            }
          } catch (error) {
            skipped += 1;
            this.stats.failed += 1;
            console.warn(`[drip-crawler] ${name}: ${error.message}`);
          }

          this.stats.processed += 1;

          if (!this.stopped) await delay(BETWEEN_VEHICLES_MS);
        }

        console.log(
          `[drip-crawler] Batch done: ${updated} updated, ${skipped} skipped — ` +
          `lifetime: ${this.stats.processed} processed, ${this.stats.photosFound} photos, ${this.stats.failed} failed`
        );

        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      } catch (error) {
        console.error('[drip-crawler] Loop error:', error.message);
        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      }
    }

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

  async _fetchPhotosForVehicle(vehicle) {
    if (!vehicle.dealerUrl) {
      throw new Error('No dealer URL');
    }

    const detailUrl = vehicle.dealerUrl.startsWith('http')
      ? vehicle.dealerUrl
      : `https://www.cars.com${vehicle.dealerUrl}`;

    const response = await fetch(detailUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${detailUrl}`);
    }

    const html = await response.text();
    return extractPhotos(html);
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
