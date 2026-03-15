'use strict';

const { BrowserWindow } = require('electron');
const { getMainWindow } = require('./window-manager');

const FEED_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VEHICLE_PAGE_SIZE = 100;
const RATE_LIMIT_MS = 2000;
const SEARCH_PAGE_TIMEOUT_MS = 30000;
const DETAIL_PAGE_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 1000;
const DETAIL_SCROLL_DELAY_MS = 800;
const DETAIL_SCROLL_PASSES = 8;
const MAX_SEARCH_PAGES = 50;
const SEARCH_PAGE_INFO_JS = `
  (function() {
    return {
      readyState: document.readyState,
      listingCount: document.querySelectorAll('a.shop-card-link[href*="vehicledetail"]').length,
      href: window.location.href
    };
  })()
`;
const SEARCH_PAGE_LISTINGS_JS = `
  (function() {
    var ids = [];
    var seen = {};
    var links = document.querySelectorAll('a.shop-card-link[href*="vehicledetail"]');
    for (var i = 0; i < links.length; i += 1) {
      var href = links[i].href || '';
      var match = href.match(/\\/vehicledetail\\/([^/?#]+)/i);
      if (!match) continue;
      var listingId = match[1];
      if (seen[listingId]) continue;
      seen[listingId] = true;
      ids.push(listingId);
    }
    return ids;
  })()
`;
const SEARCH_PAGE_COUNT_JS = `
  (function() {
    var maxPage = 1;
    document.querySelectorAll('a[id^="pagination-direct-link-"]').forEach(function(a) {
      var match = a.id.match(/pagination-direct-link-(\\d+)/);
      if (match) maxPage = Math.max(maxPage, parseInt(match[1], 10));
    });
    document.querySelectorAll('[phx-value-page]').forEach(function(el) {
      var num = parseInt(el.getAttribute('phx-value-page'), 10);
      if (!isNaN(num)) maxPage = Math.max(maxPage, num);
    });
    document.querySelectorAll('a[href*="page="]').forEach(function(a) {
      var match = a.href.match(/[?&]page=(\\d+)/);
      if (match) maxPage = Math.max(maxPage, parseInt(match[1], 10));
    });
    document.querySelectorAll('.sds-pagination__item, .pagination li').forEach(function(el) {
      var text = (el.textContent || '').trim();
      if (text.length > 3) return;
      var num = parseInt(text, 10);
      if (!isNaN(num) && num > 0) maxPage = Math.max(maxPage, num);
    });
    return maxPage;
  })()
`;
const DETAIL_PAGE_INFO_JS = `
  (function() {
    var count = 0;
    var imgs = document.querySelectorAll('img[src*="cstatic-images.com"]');
    for (var i = 0; i < imgs.length; i += 1) {
      var src = imgs[i].src || '';
      if (!src) continue;
      if (src.indexOf('dealer_media') !== -1) continue;
      if (src.indexOf('static/app-images') !== -1) continue;
      if (/\\.svg(?:\\?|#|$)/i.test(src)) continue;
      count += 1;
    }
    return {
      href: window.location.href,
      imageCount: count
    };
  })()
`;
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

function isStoppedError(error) {
  return error && error.message === 'Image fetch stopped';
}

function getFeedName(feed) {
  return feed?.name || feed?.feedUrl || `Feed ${feed?.id || 'unknown'}`;
}

function getVehicleName(vehicle) {
  return [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ') || vehicle?.vin || 'Vehicle';
}

function getListingIdFromDealerUrl(dealerUrl) {
  if (typeof dealerUrl !== 'string') return null;
  const match = dealerUrl.match(/\/vehicledetail\/([^/?#]+)/i);
  return match ? match[1] : null;
}

function buildPaginatedUrl(baseUrl, page) {
  const nextUrl = new URL(baseUrl);
  if (page <= 1) {
    nextUrl.searchParams.delete('page');
  } else {
    nextUrl.searchParams.set('page', String(page));
  }
  return nextUrl.toString();
}

function escapeForJavaScript(value) {
  return JSON.stringify(String(value || ''));
}

class FeedImageFetcher {
  constructor(serverUrl, accessToken) {
    this.serverUrl = serverUrl || '';
    this.accessToken = accessToken || '';
    this.feed = null;
    this.win = null;
    this.stopped = false;
    this.currentSearchPage = 1;
    this.lastDetailLoadAt = 0;
    this.listingPageMap = new Map();
  }

  stop() {
    this.stopped = true;

    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.webContents.stop();
      } catch (_) {
        // Ignore shutdown errors.
      }

      try {
        this.win.destroy();
      } catch (_) {
        // Ignore shutdown errors.
      }
    }

    this.win = null;
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

  async executeJavaScript(script) {
    this.ensureActive();
    if (!this.win || this.win.isDestroyed()) {
      throw new Error('Image fetch stopped');
    }
    return this.win.webContents.executeJavaScript(script);
  }

  async start(feed) {
    this.feed = feed;
    this.stopped = false;
    this.currentSearchPage = 1;
    this.lastDetailLoadAt = 0;
    this.listingPageMap = new Map();

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

      this.sendEvent('image-fetch-start', {
        feedId: feed?.id,
        feedName,
        total: vehicles.length,
      });

      this.win = new BrowserWindow({
        show: false,
        width: 1920,
        height: 1080,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      await this.win.webContents.session.setUserAgent(FEED_FETCH_UA);
      await this.loadSearchPage(1);
      await this.buildListingPageMap();
      this.sortVehiclesBySearchPage(vehicles);

      let updated = 0;
      let skipped = 0;

      for (let index = 0; index < vehicles.length; index += 1) {
        this.ensureActive();

        const vehicle = vehicles[index];
        const vehicleName = getVehicleName(vehicle);
        this.sendEvent('image-fetch-progress', {
          feedId: feed?.id,
          feedName,
          current: index + 1,
          total: vehicles.length,
          vehicleName,
        });

        try {
          const photoUrls = await this.fetchVehiclePhotos(vehicle);

          if (photoUrls.length === 0) {
            skipped += 1;
            console.warn(`[feed-image-fetcher] No photos found for ${vehicleName} (${vehicle.id})`);
            continue;
          }

          await this.updateVehiclePhotos(vehicle.id, photoUrls);
          updated += 1;
        } catch (error) {
          if (isStoppedError(error)) {
            throw error;
          }

          skipped += 1;
          console.warn(
            `[feed-image-fetcher] Failed for ${vehicleName} (${vehicle.id}): ${error.message}`
          );
        }
      }

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
      if (this.win && !this.win.isDestroyed()) {
        this.win.destroy();
      }
      this.win = null;
    }
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
        vehicles.push({
          ...vehicle,
          listingId: getListingIdFromDealerUrl(vehicle?.dealerUrl),
        });
      }

      if (pageVehicles.length < VEHICLE_PAGE_SIZE) {
        break;
      }

      offset += VEHICLE_PAGE_SIZE;
    }

    return vehicles;
  }

  sortVehiclesBySearchPage(vehicles) {
    vehicles.sort((a, b) => {
      const aPage = this.listingPageMap.get(a.listingId) || Number.MAX_SAFE_INTEGER;
      const bPage = this.listingPageMap.get(b.listingId) || Number.MAX_SAFE_INTEGER;
      if (aPage !== bPage) return aPage - bPage;
      return getVehicleName(a).localeCompare(getVehicleName(b));
    });
  }

  async loadSearchPage(page, { retries = 3 } = {}) {
    this.ensureActive();
    this.currentSearchPage = page;
    const searchUrl = buildPaginatedUrl(this.feed.feedUrl, page);

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await this.win.loadURL(searchUrl);
        await this.waitForSearchPage();
        return;
      } catch (error) {
        if (isStoppedError(error)) throw error;
        if (attempt >= retries) throw error;
        const backoff = RATE_LIMIT_MS * attempt;
        console.warn(
          `[feed-image-fetcher] Page ${page} load failed (attempt ${attempt}/${retries}): ${error.message} — retrying in ${backoff}ms`
        );
        await delay(backoff);
      }
    }
  }

  async waitForSearchPage() {
    const startedAt = Date.now();

    while (Date.now() - startedAt < SEARCH_PAGE_TIMEOUT_MS) {
      this.ensureActive();

      const info = await this.executeJavaScript(SEARCH_PAGE_INFO_JS);
      if (Number(info?.listingCount) > 0) {
        return info;
      }

      await delay(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for search page ${this.currentSearchPage}`);
  }

  async buildListingPageMap() {
    const totalPages = await this.detectSearchPageCount();

    for (let page = 1; page <= totalPages; page += 1) {
      this.ensureActive();

      if (page !== this.currentSearchPage) {
        // Rate limit between search page loads to avoid anti-bot blocking
        await delay(RATE_LIMIT_MS);
        try {
          await this.loadSearchPage(page);
        } catch (error) {
          if (isStoppedError(error)) throw error;
          console.warn(
            `[feed-image-fetcher] Skipping search page ${page}/${totalPages}: ${error.message}`
          );
          continue;
        }
      }

      const listingIds = await this.executeJavaScript(SEARCH_PAGE_LISTINGS_JS);
      for (const listingId of Array.isArray(listingIds) ? listingIds : []) {
        if (!this.listingPageMap.has(listingId)) {
          this.listingPageMap.set(listingId, page);
        }
      }
    }
  }

  async detectSearchPageCount() {
    try {
      const count = await this.executeJavaScript(SEARCH_PAGE_COUNT_JS);
      const parsed = Number.parseInt(String(count), 10);
      if (!Number.isFinite(parsed) || parsed < 2) return 1;
      return Math.min(parsed, MAX_SEARCH_PAGES);
    } catch (error) {
      console.warn('[feed-image-fetcher] Failed to detect search page count:', error.message);
      return 1;
    }
  }

  async fetchVehiclePhotos(vehicle) {
    const listingId = vehicle?.listingId;
    if (!listingId) {
      throw new Error('Missing listing id');
    }

    const targetPage = this.listingPageMap.get(listingId);
    if (!targetPage) {
      throw new Error(`Listing ${listingId} not found on search pages`);
    }

    if (targetPage !== this.currentSearchPage) {
      await this.loadSearchPage(targetPage);
    }

    try {
      await this.rateLimitBeforeDetailLoad();

      const clicked = await this.executeJavaScript(`
        (function() {
          var links = document.querySelectorAll('a.shop-card-link[href*="vehicledetail"]');
          var listingId = ${escapeForJavaScript(listingId)};
          for (var i = 0; i < links.length; i += 1) {
            var href = links[i].href || '';
            if (!href.includes(listingId)) continue;
            links[i].click();
            return true;
          }
          return false;
        })()
      `);

      if (!clicked) {
        throw new Error(`Listing ${listingId} not clickable on page ${targetPage}`);
      }

      this.lastDetailLoadAt = Date.now();
      await this.waitForDetailPage(listingId);
      const photoUrls = await this.collectDetailImages();
      await this.navigateBackToSearchPage();
      return photoUrls;
    } catch (error) {
      if (isStoppedError(error)) {
        throw error;
      }

      try {
        await this.loadSearchPage(targetPage);
      } catch (resetError) {
        if (isStoppedError(resetError)) {
          throw resetError;
        }
      }

      throw error;
    }
  }

  async rateLimitBeforeDetailLoad() {
    const elapsed = Date.now() - this.lastDetailLoadAt;
    if (elapsed < RATE_LIMIT_MS) {
      await delay(RATE_LIMIT_MS - elapsed);
    }
  }

  async waitForDetailPage(listingId) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < DETAIL_PAGE_TIMEOUT_MS) {
      this.ensureActive();

      const info = await this.executeJavaScript(DETAIL_PAGE_INFO_JS);
      const href = String(info?.href || '');
      const imageCount = Number(info?.imageCount || 0);

      if (href.includes(listingId) && imageCount > 0) {
        return info;
      }

      await delay(POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for detail page ${listingId}`);
  }

  async collectDetailImages() {
    let bestUrls = [];

    for (let pass = 0; pass < DETAIL_SCROLL_PASSES; pass += 1) {
      this.ensureActive();

      await this.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
      await delay(DETAIL_SCROLL_DELAY_MS);

      const urls = await this.executeJavaScript(DETAIL_IMAGES_JS);
      const normalized = Array.isArray(urls) ? urls : [];

      if (normalized.length > bestUrls.length) {
        bestUrls = normalized;
      } else if (normalized.length > 0 && normalized.length === bestUrls.length) {
        break;
      }
    }

    return bestUrls;
  }

  async navigateBackToSearchPage() {
    this.ensureActive();

    try {
      await this.executeJavaScript('window.history.back()');
      await this.waitForSearchPage();
    } catch (error) {
      if (isStoppedError(error)) throw error;
      await this.loadSearchPage(this.currentSearchPage);
      return;
    }

    await delay(1000);
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
