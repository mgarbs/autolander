'use strict';

/**
 * Feed Drip Crawler — background photo fetcher using Electron's net module.
 *
 * Uses Chromium's networking stack (via Electron's net module) instead of
 * Node.js fetch() to avoid TLS fingerprint-based bot detection.
 *
 * Why this matters:
 *   Node.js fetch() (undici) produces a JA3/JA4 TLS fingerprint that differs
 *   between macOS and Windows builds. Cars.com fingerprints the Mac signature
 *   and blocks it, returning empty/challenge pages. Electron's net module uses
 *   Chromium's TLS stack which has the same fingerprint as a real browser,
 *   passing through bot detection on all platforms.
 *
 * Stealth features:
 *   - Chromium TLS fingerprint (not Node.js undici)
 *   - Randomized jitter between requests (no fixed-interval patterns)
 *   - Session rotation every N vehicles (fresh cookies + TLS state)
 *   - Full browser-like request headers (Sec-Ch-Ua, Sec-Fetch-*, etc.)
 *   - Extended pause + session reset on network errors / rate limiting
 *   - Graceful degradation (never fully aborts, just backs off)
 *
 * Flow:
 *   1. Query API for a small batch of vehicles missing photos
 *   2. For each vehicle, fetch its detail page via Electron net module
 *   3. Parse HTML with cheerio to extract photo URLs
 *   4. Save photos immediately via API
 *   5. Wait between vehicles with randomized jitter
 *   6. When batch is done, wait and check for more
 *   7. When all vehicles have photos, idle and check periodically
 */

const { net, session } = require('electron');
const cheerio = require('cheerio');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Timing ---
// Base delays get jitter applied (0.5x to 1.5x), so 5s becomes 2.5–7.5s
const BASE_BETWEEN_VEHICLES_MS = 5_000;
const BETWEEN_BATCHES_MS = 2 * 60_000;      // 2 min between batches
const IDLE_CHECK_MS = 10 * 60_000;           // 10 min when nothing to do
const FETCH_TIMEOUT_MS = 25_000;             // 25s per request
const NETWORK_ERROR_PAUSE_MS = 30_000;       // 30s pause after network error
const BATCH_SIZE = 10;
const MAX_CONSECUTIVE_FAILURES = 8;
const SESSION_ROTATE_EVERY = 20;             // fresh session every N vehicles

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Randomized jitter — returns base * [0.5, 1.5).
 * Prevents fixed-interval request patterns that trigger bot detection.
 */
function jitter(baseMs) {
  return Math.round(baseMs * (0.5 + Math.random()));
}

/**
 * Fetch a URL using Electron's net module (Chromium TLS fingerprint).
 *
 * This is the core Mac fix. Electron's net.request() goes through Chromium's
 * network stack, producing the same JA3/JA4 TLS fingerprint as Chrome.
 * Cars.com's bot detection sees a real browser, not a Node.js bot.
 */
function electronFetch(url, ses) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      try { request.abort(); } catch {}
      reject(new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms`));
    }, FETCH_TIMEOUT_MS);

    const request = net.request({
      url,
      method: 'GET',
      session: ses,
      useSessionCookies: true,
    });

    // Full set of browser-like headers — matches a real Chrome 120 request
    request.setHeader('User-Agent', UA);
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8');
    request.setHeader('Accept-Language', 'en-US,en;q=0.9');
    request.setHeader('Accept-Encoding', 'gzip, deflate, br');
    request.setHeader('Cache-Control', 'no-cache');
    request.setHeader('Sec-Ch-Ua', '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
    request.setHeader('Sec-Ch-Ua-Mobile', '?0');
    request.setHeader('Sec-Ch-Ua-Platform', '"Windows"');
    request.setHeader('Sec-Fetch-Dest', 'document');
    request.setHeader('Sec-Fetch-Mode', 'navigate');
    request.setHeader('Sec-Fetch-Site', 'none');
    request.setHeader('Sec-Fetch-User', '?1');
    request.setHeader('Upgrade-Insecure-Requests', '1');

    request.on('response', (response) => {
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
      });

      response.on('end', () => {
        clearTimeout(timeoutId);
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body,
        });
      });

      response.on('error', (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    });

    request.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    request.end();
  });
}

/**
 * Check if a URL is a valid vehicle photo (not a logo, icon, or UI image).
 */
function isVehiclePhoto(src) {
  if (!src) return false;
  if (src.includes('dealer_media')) return false;
  if (src.includes('static/app-images')) return false;
  if (src.includes('placeholder')) return false;
  if (src.includes('no-image')) return false;
  if (src.includes('logo')) return false;
  if (src.includes('favicon')) return false;
  if (/\.svg(?:\?|#|$)/i.test(src)) return false;
  if (/\b(?:1x1|spacer|pixel|blank)\b/i.test(src)) return false;
  if (src.includes('dealerrater.com')) return false;
  if (src.includes('/employees/')) return false;
  if (src.includes('/mobile-apps/')) return false;
  if (src.includes('app-store')) return false;
  if (src.includes('google-play')) return false;
  if (src.includes('cldstatic/wp-content')) return false;
  if (src.includes('assets.carsdn.co')) return false;
  if (src.includes('/csa/')) return false;
  if (src.includes('seal.png')) return false;
  if (src.includes('og-img')) return false;
  if (src.includes('sprite')) return false;
  if (src.includes('icon')) return false;
  if (src.includes('badge')) return false;
  if (src.includes('banner')) return false;
  if (src.includes('tracking')) return false;
  if (src.includes('analytics')) return false;
  if (src.includes('ad-')) return false;
  if (src.includes('/ads/')) return false;
  return true;
}

/**
 * Upgrade cstatic-images.com thumbnails to full size.
 */
function upgradeSize(src) {
  if (typeof src !== 'string') return src;
  return src.replace(
    /\/(?:small|medium|large|xlarge)\/in\/v2\//i,
    '/xxlarge/in/v2/'
  );
}

/**
 * Extract photo URLs from vehicle detail page HTML.
 *
 * Priority order (use the FIRST source that yields photos):
 *   1. JSON-LD structured data — contains only the vehicle's gallery photos
 *   2. <img> tags — fallback, but picks up "similar vehicles" section too
 *
 * Cars.com detail pages have 10-20 gallery photos plus 20+ thumbnails from
 * "Similar Vehicles" and recommendation sections. JSON-LD only contains the
 * real gallery, so we prefer it and skip <img> scraping when it works.
 *
 * Capped at 20 photos (FB Marketplace max).
 */
function extractPhotos(html) {
  const MAX_PHOTOS = 20;
  const $ = cheerio.load(html);
  const seen = new Set();

  function collect(src) {
    if (!src || !isVehiclePhoto(src)) return null;
    const upgraded = upgradeSize(src.trim());
    if (!upgraded || seen.has(upgraded)) return null;
    seen.add(upgraded);
    return upgraded;
  }

  // 1. JSON-LD structured data — preferred source (gallery photos only)
  const jsonLdPhotos = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const images = Array.isArray(data.image) ? data.image : data.image ? [data.image] : [];
      for (const img of images) {
        const url = collect(typeof img === 'string' ? img : img?.url || img?.contentUrl);
        if (url) jsonLdPhotos.push(url);
      }
    } catch {}
  });

  // Filter to cstatic vehicle photos
  const jsonLdVehicle = jsonLdPhotos.filter(u => u.includes('cstatic-images.com') && u.includes('/in/v2/'));
  if (jsonLdVehicle.length > 0) {
    return jsonLdVehicle.slice(0, MAX_PHOTOS);
  }
  if (jsonLdPhotos.length > 0) {
    return jsonLdPhotos.slice(0, MAX_PHOTOS);
  }

  // 2. Fallback: <img> tags — but ONLY cstatic vehicle photos, capped at MAX_PHOTOS.
  // JSON-LD is preferred but not all cars.com detail pages include it.
  // The cap prevents picking up "similar vehicles" section photos (which appear
  // after the gallery). The gallery is always first on the page.
  const imgPhotos = [];
  $('img').each((_, el) => {
    if (imgPhotos.length >= MAX_PHOTOS) return false; // stop early
    const node = $(el);
    for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src']) {
      const url = collect(node.attr(attr));
      if (url && url.includes('cstatic-images.com') && url.includes('/in/v2/')) {
        imgPhotos.push(url);
        break;
      }
    }
  });

  return imgPhotos.slice(0, MAX_PHOTOS);
}

function isNetworkError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    msg.includes('ERR_FAILED') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('ERR_SSL') ||
    msg.includes('ERR_NETWORK') ||
    msg.includes('net_error') ||
    msg.includes('Timed out') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('HTTP 403') ||
    msg.includes('HTTP 429')
  );
}

class FeedDripCrawler {
  constructor() {
    this.serverUrl = '';
    this.accessToken = '';
    this.running = false;
    this.stopped = false;
    this.stats = { processed: 0, photosFound: 0, failed: 0 };
    this._session = null;
    this._vehiclesSinceRotate = 0;
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
    this._vehiclesSinceRotate = 0;
    this._session = null;

    console.log('[drip-crawler] Starting background photo crawler (Electron net mode — Chromium TLS)');
    this._runLoop();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this._session = null;
    console.log('[drip-crawler] Stopped');
  }

  /**
   * Get or create an Electron session for HTTP requests.
   * Rotates periodically to avoid session-level rate limiting.
   */
  _getSession() {
    if (!this._session || this._vehiclesSinceRotate >= SESSION_ROTATE_EVERY) {
      this._clearSession();
      const partition = `drip-crawler-${Date.now()}`;
      this._session = session.fromPartition(partition, { cache: false });
      this._session.setUserAgent(UA);
      this._vehiclesSinceRotate = 0;
      console.log('[drip-crawler] Rotated to fresh session');
    }
    return this._session;
  }

  _resetSession() {
    this._clearSession();
    this._vehiclesSinceRotate = 0;
  }

  _clearSession() {
    if (this._session) {
      this._session.clearStorageData().catch(() => {});
      this._session = null;
    }
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

  _handleAuthExpired() {
    console.error('[drip-crawler] Auth token expired (401) — stopping crawler');
    this.stop();
    try {
      const { getMainWindow } = require('./window-manager');
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth:expired');
      }
    } catch (_) {}
  }

  async _runLoop() {
    if (this.running) return;
    this.running = true;

    // Initial delay — let the app settle after login
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
        let consecutiveFailures = 0;

        for (const vehicle of vehicles) {
          if (this.stopped) break;

          const name = [vehicle.year, vehicle.make, vehicle.model]
            .filter(Boolean).join(' ') || vehicle.vin || 'Vehicle';

          try {
            const photos = await this._fetchPhotosForVehicle(vehicle);
            this._vehiclesSinceRotate += 1;

            if (photos.length > 0) {
              await this._savePhotos(vehicle.id, photos);
              updated += 1;
              consecutiveFailures = 0;
              this.stats.photosFound += photos.length;
              console.log(`[drip-crawler] ${name}: ${photos.length} photos saved`);
            } else {
              skipped += 1;
              consecutiveFailures += 1;
              console.log(`[drip-crawler] ${name}: no photos found on detail page`);
            }
          } catch (error) {
            skipped += 1;
            consecutiveFailures += 1;
            this.stats.failed += 1;
            console.warn(`[drip-crawler] ${name}: ${error.message}`);

            // Network / rate-limit errors — rotate session + extended pause
            if (isNetworkError(error)) {
              console.warn('[drip-crawler] Network error detected — rotating session, pausing');
              this._resetSession();
              if (!this.stopped) await delay(jitter(NETWORK_ERROR_PAUSE_MS));
              consecutiveFailures = Math.max(0, consecutiveFailures - 1); // don't count network issues toward abort
            }

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              console.error(
                `[drip-crawler] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — ` +
                'pausing batch (will retry next cycle)'
              );
              this._resetSession();
              break;
            }
          }

          this.stats.processed += 1;

          // Randomized delay — jitter makes the pattern look human
          if (!this.stopped) await delay(jitter(BASE_BETWEEN_VEHICLES_MS));
        }

        console.log(
          `[drip-crawler] Batch done: ${updated} updated, ${skipped} skipped — ` +
          `lifetime: ${this.stats.processed} processed, ` +
          `${this.stats.photosFound} photos, ${this.stats.failed} failed`
        );

        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      } catch (error) {
        console.error('[drip-crawler] Loop error:', error.message);
        this._resetSession();
        if (!this.stopped) await delay(BETWEEN_BATCHES_MS);
      }
    }

    this.running = false;
  }

  /**
   * Fetch vehicles that need photos from the API.
   * Uses Node.js fetch() for the internal API call (localhost, no TLS issue).
   */
  async _fetchVehiclesMissingPhotos() {
    const url = this._buildApiUrl(
      `/api/vehicles?missingPhotos=true&status=ACTIVE&limit=${BATCH_SIZE}&offset=0`
    );
    const response = await fetch(url, { headers: this._authHeaders() });

    if (!response.ok) {
      if (response.status === 401) { this._handleAuthExpired(); return []; }
      throw new Error(`API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.vehicles) ? data.vehicles : [];
  }

  /**
   * Fetch photos for a single vehicle by loading its detail page.
   * Uses Electron's net module (Chromium TLS) to avoid Mac bot detection.
   */
  async _fetchPhotosForVehicle(vehicle) {
    if (!vehicle.dealerUrl) {
      throw new Error('No dealer URL');
    }

    const detailUrl = vehicle.dealerUrl.startsWith('http')
      ? vehicle.dealerUrl
      : `https://www.cars.com${vehicle.dealerUrl}`;

    const ses = this._getSession();
    const response = await electronFetch(detailUrl, ses);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching detail page`);
    }

    // Check for challenge/captcha pages (cars.com bot detection)
    if (response.body.includes('Client Challenge') ||
        response.body.includes('Enter the characters') ||
        response.body.includes('captcha')) {
      console.warn('[drip-crawler] Challenge page detected — rotating session');
      this._resetSession();
      throw new Error('Challenge page detected (rate limited)');
    }

    return extractPhotos(response.body);
  }

  /**
   * Save photo URLs to the API.
   * Uses Node.js fetch() for the internal API call (localhost, no TLS issue).
   */
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
