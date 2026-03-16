'use strict';

/**
 * Feed Image Fetcher — fast, Mac-safe photo extraction using Electron net.
 *
 * Previous approach: spin up a full BrowserWindow for each vehicle's detail
 * page, wait up to 30s for images to render, scroll 8 times. Per vehicle
 * that was 30-40 seconds, freezing on Mac due to GPU crashes.
 *
 * New approach: HTTP GET the detail page via Electron's net module (Chromium
 * TLS fingerprint, no GPU needed), parse with cheerio. Per vehicle: ~2-3s.
 * Runs 3 concurrent fetches for throughput while staying under the radar.
 *
 * Cars.com serves full image URLs in server-rendered HTML — no browser
 * rendering or JavaScript execution needed.
 */

const { net, session } = require('electron');
const cheerio = require('cheerio');
const { getMainWindow } = require('./window-manager');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const VEHICLE_PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_FAILURES = 8;
const SESSION_ROTATE_EVERY = 25;
const CONCURRENCY = 3;                // parallel detail page fetches
const BASE_DELAY_MS = 1_500;           // ~0.75-2.25s with jitter per request
const NETWORK_ERROR_PAUSE_MS = 15_000; // extra pause after rate limit / block

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs) {
  return Math.round(baseMs * (0.5 + Math.random()));
}

function getFeedName(feed) {
  return feed?.name || feed?.feedUrl || `Feed ${feed?.id || 'unknown'}`;
}

function getVehicleName(vehicle) {
  return [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ') || vehicle?.vin || 'Vehicle';
}

function isStoppedError(error) {
  return error && error.message === 'Image fetch stopped';
}

/**
 * Fetch URL via Electron net module (Chromium TLS fingerprint).
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
      response.on('data', (chunk) => chunks.push(chunk));
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
 * Extract photo URLs from detail page HTML using cheerio.
 */
function extractPhotos(html) {
  const $ = cheerio.load(html);
  const urls = [];
  const seen = new Set();

  function add(src) {
    if (!src) return;
    if (!src.includes('cstatic-images.com')) return;
    if (src.includes('dealer_media')) return;
    if (src.includes('static/app-images')) return;
    if (src.includes('placeholder')) return;
    if (/\.svg(?:\?|#|$)/i.test(src)) return;
    if (/\b(?:1x1|spacer|pixel|blank)\b/i.test(src)) return;
    const upgraded = src.replace(
      /\/(?:small|medium|large|xlarge)\/in\/v2\//i,
      '/xxlarge/in/v2/'
    );
    if (seen.has(upgraded)) return;
    seen.add(upgraded);
    urls.push(upgraded);
  }

  $('img').each((_, el) => {
    const node = $(el);
    add(node.attr('src'));
    add(node.attr('data-src'));
    add(node.attr('data-original'));
    add(node.attr('data-lazy-src'));
    add(node.attr('data-hi-res-src'));
  });

  $('source[srcset]').each((_, el) => {
    const srcset = $(el).attr('srcset') || '';
    for (const part of srcset.split(',')) {
      add(part.trim().split(/\s+/)[0]);
    }
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const images = Array.isArray(data.image) ? data.image : data.image ? [data.image] : [];
      for (const img of images) {
        add(typeof img === 'string' ? img : img?.url || img?.contentUrl);
      }
    } catch {}
  });

  $('meta[property="og:image"]').each((_, el) => {
    add($(el).attr('content'));
  });

  return urls;
}

function isNetworkError(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    msg.includes('ERR_FAILED') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('ERR_SSL') ||
    msg.includes('ERR_NETWORK') ||
    msg.includes('Timed out') ||
    msg.includes('HTTP 403') ||
    msg.includes('HTTP 429') ||
    msg.includes('Challenge page')
  );
}

class FeedImageFetcher {
  constructor(serverUrl, accessToken) {
    this.serverUrl = serverUrl || '';
    this.accessToken = accessToken || '';
    this.feed = null;
    this.stopped = false;
    this._session = null;
    this._vehiclesSinceRotate = 0;
  }

  stop() {
    this.stopped = true;
    this._session = null;
  }

  ensureActive() {
    if (this.stopped) {
      throw new Error('Image fetch stopped');
    }
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

  sendEvent(type, data = {}) {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('feed:image-fetch', { type, ...data });
    }
  }

  _getSession() {
    if (!this._session || this._vehiclesSinceRotate >= SESSION_ROTATE_EVERY) {
      this._clearSession();
      const partition = `image-fetcher-${Date.now()}`;
      this._session = session.fromPartition(partition, { cache: false });
      this._session.setUserAgent(UA);
      this._vehiclesSinceRotate = 0;
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

  async start(feed) {
    this.feed = feed;
    this.stopped = false;
    this._vehiclesSinceRotate = 0;
    this._session = null;

    const feedName = getFeedName(feed);

    try {
      const vehicles = await this.fetchVehiclesMissingPhotos(feed?.id);
      this.ensureActive();

      if (vehicles.length === 0) {
        this.sendEvent('image-fetch-complete', {
          feedId: feed?.id,
          feedName,
          total: 0,
          updated: 0,
          skipped: 0,
        });
        return { total: 0, updated: 0, skipped: 0 };
      }

      console.log(`[feed-image-fetcher] Starting photo fetch for ${vehicles.length} vehicles (net mode, concurrency=${CONCURRENCY})`);

      this.sendEvent('image-fetch-start', {
        feedId: feed?.id,
        feedName,
        total: vehicles.length,
      });

      let updated = 0;
      let skipped = 0;
      let completed = 0;
      let consecutiveFailures = 0;

      // Process in chunks of CONCURRENCY for parallel fetching
      for (let i = 0; i < vehicles.length; i += CONCURRENCY) {
        this.ensureActive();

        const chunk = vehicles.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map((vehicle) => this._processOneVehicle(vehicle))
        );

        for (let j = 0; j < results.length; j += 1) {
          completed += 1;
          const vehicle = chunk[j];
          const vehicleName = getVehicleName(vehicle);
          const result = results[j];

          // Send progress for each completed vehicle
          this.sendEvent('image-fetch-progress', {
            feedId: feed?.id,
            feedName,
            current: completed,
            total: vehicles.length,
            vehicleName,
          });

          if (result.status === 'fulfilled') {
            const photoCount = result.value;
            if (photoCount > 0) {
              updated += 1;
              consecutiveFailures = 0;
            } else {
              skipped += 1;
              consecutiveFailures += 1;
            }
          } else {
            skipped += 1;
            const error = result.reason;

            if (!isStoppedError(error)) {
              consecutiveFailures += 1;
              console.warn(`[feed-image-fetcher] Failed: ${vehicleName}: ${error.message}`);

              if (isNetworkError(error)) {
                this._resetSession();
              }
            }
          }
        }

        // Log progress every few chunks
        if (completed % 15 === 0 || completed === vehicles.length) {
          console.log(
            `[feed-image-fetcher] Progress: ${updated} updated, ${skipped} skipped of ${vehicles.length}`
          );
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `[feed-image-fetcher] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping`
          );
          this._resetSession();
          // Extra long pause then try to continue with fresh session
          await delay(NETWORK_ERROR_PAUSE_MS);
          consecutiveFailures = 0;
        }

        // Jittered delay between chunks
        if (i + CONCURRENCY < vehicles.length && !this.stopped) {
          await delay(jitter(BASE_DELAY_MS));
        }
      }

      console.log(
        `[feed-image-fetcher] Complete: ${updated} updated, ${skipped} skipped of ${vehicles.length}`
      );

      this.sendEvent('image-fetch-complete', {
        feedId: feed?.id,
        feedName,
        total: vehicles.length,
        updated,
        skipped,
      });

      return { total: vehicles.length, updated, skipped };
    } catch (error) {
      if (isStoppedError(error)) {
        this.sendEvent('image-fetch-cancelled', {
          feedId: feed?.id,
          feedName,
        });
        return { cancelled: true };
      }

      this.sendEvent('image-fetch-error', {
        feedId: feed?.id,
        feedName,
        error: error.message,
      });
      throw error;
    } finally {
      this._clearSession();
    }
  }

  /**
   * Fetch and save photos for a single vehicle.
   * Returns the number of photos found.
   */
  async _processOneVehicle(vehicle) {
    this.ensureActive();

    const detailUrl = vehicle.dealerUrl;
    if (!detailUrl) return 0;

    const fullUrl = detailUrl.startsWith('http')
      ? detailUrl
      : `https://www.cars.com${detailUrl}`;

    const ses = this._getSession();
    this._vehiclesSinceRotate += 1;

    const response = await electronFetch(fullUrl, ses);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Detect challenge/captcha pages
    if (response.body.includes('Client Challenge') ||
        response.body.includes('Enter the characters') ||
        response.body.includes('captcha')) {
      throw new Error('Challenge page detected');
    }

    const photos = extractPhotos(response.body);
    if (photos.length === 0) return 0;

    await this.updateVehiclePhotos(vehicle.id, photos);
    return photos.length;
  }

  async fetchVehiclesMissingPhotos(feedId) {
    const vehicles = [];
    let offset = 0;

    while (true) {
      this.ensureActive();

      const url = this.buildApiUrl(
        `/api/vehicles?feedId=${encodeURIComponent(feedId)}&missingPhotos=true&status=ACTIVE&limit=${VEHICLE_PAGE_SIZE}&offset=${offset}`
      );
      const response = await fetch(url, {
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch vehicles: HTTP ${response.status}`);
      }

      const data = await response.json();
      const pageVehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];

      for (const vehicle of pageVehicles) {
        if (vehicle?.dealerUrl) {
          vehicles.push(vehicle);
        }
      }

      if (pageVehicles.length < VEHICLE_PAGE_SIZE) {
        break;
      }

      offset += VEHICLE_PAGE_SIZE;
    }

    return vehicles;
  }

  async updateVehiclePhotos(vehicleId, photos) {
    this.ensureActive();

    const response = await fetch(this.buildApiUrl(`/api/vehicles/${encodeURIComponent(vehicleId)}/photos`), {
      method: 'PUT',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({ photos }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (_) {
        detail = '';
      }

      throw new Error(
        detail
          ? `Photo update failed: HTTP ${response.status} ${detail}`.trim()
          : `Photo update failed: HTTP ${response.status}`
      );
    }
  }
}

// --- Job queue (same interface as before) ---

const pendingJobs = [];
let activeJob = null;
let queueRunning = false;

function resolveCancelledJobs(filterFn) {
  for (let index = pendingJobs.length - 1; index >= 0; index -= 1) {
    if (!filterFn(pendingJobs[index])) continue;
    const [job] = pendingJobs.splice(index, 1);
    job.resolve({ queued: false, cancelled: true });
  }
}

async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;

  try {
    while (pendingJobs.length > 0) {
      const job = pendingJobs.shift();
      const fetcher = new FeedImageFetcher(job.serverUrl, job.accessToken);
      activeJob = { ...job, fetcher };

      try {
        const result = await fetcher.start(job.feed);
        job.resolve({ queued: false, ...result });
      } catch (error) {
        job.reject(error);
      } finally {
        if (activeJob?.feed?.id === job.feed.id) {
          activeJob = null;
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

function enqueueFeedImageFetch(serverUrl, accessToken, feed) {
  if (!feed?.id || !feed?.feedUrl) {
    return Promise.resolve({ queued: false, skipped: true, reason: 'invalid-feed' });
  }

  if (activeJob?.feed?.id === feed.id) {
    if (activeJob.feed.feedUrl === feed.feedUrl) {
      return activeJob.promise;
    }

    activeJob.fetcher.stop();
  }

  const existingJob = pendingJobs.find((job) => job.feed?.id === feed.id);
  if (existingJob) {
    existingJob.feed = feed;
    existingJob.serverUrl = serverUrl;
    existingJob.accessToken = accessToken;
    return existingJob.promise;
  }

  let resolveJob;
  let rejectJob;
  const promise = new Promise((resolve, reject) => {
    resolveJob = resolve;
    rejectJob = reject;
  });

  pendingJobs.push({
    serverUrl,
    accessToken,
    feed,
    promise,
    resolve: resolveJob,
    reject: rejectJob,
  });

  void processQueue();
  return promise;
}

function stopFeedImageFetch(feedId) {
  if (feedId) {
    resolveCancelledJobs((job) => job.feed?.id === feedId);
    if (activeJob?.feed?.id === feedId) {
      activeJob.fetcher.stop();
    }
    return;
  }

  resolveCancelledJobs(() => true);
  if (activeJob) {
    activeJob.fetcher.stop();
  }
}

module.exports = {
  FeedImageFetcher,
  enqueueFeedImageFetch,
  stopFeedImageFetch,
};
