'use strict';

const cheerio = require('cheerio');
const { createEmptyVehicle, inferCondition } = require('./schema');

const LOG_PREFIX = '[feed-parser:carscom]';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQUEST_TIMEOUT_MS = 30000;
const CARSCOM_BASE_URL = 'https://www.cars.com';
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const VIN_FINDER_REGEX = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function normalizePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = String(value).replace(/[^\d.]/g, '');
  if (!numeric) return null;
  const parsed = Number.parseFloat(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeYear(value) {
  if (value == null) return null;
  const currentYear = new Date().getFullYear();
  const parsed = Number.parseInt(String(value).match(/\d{4}/)?.[0] || '', 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1990 || parsed > currentYear + 2) return null;
  return parsed;
}

function normalizeMileage(value) {
  if (value == null) return null;
  const numeric = String(value).replace(/[^\d]/g, '');
  if (!numeric) return null;
  const parsed = Number.parseInt(numeric, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeVin(value) {
  const vin = cleanText(value)?.toUpperCase() || null;
  if (!vin) return null;
  return VIN_REGEX.test(vin) ? vin : null;
}

function extractVin(text) {
  if (!text) return null;
  const match = String(text).toUpperCase().match(VIN_FINDER_REGEX);
  if (!match) return null;
  return normalizeVin(match[1]);
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function resolveUrl(value, baseUrl) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^[a-z]+:/i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  try {
    return new URL(text, baseUrl || CARSCOM_BASE_URL).toString();
  } catch {
    return text;
  }
}

function upgradePhotoSize(url) {
  // Upgrade cstatic-images.com thumbnails to full size
  // e.g. /medium/in/v2/... → /xxlarge/in/v2/...
  if (typeof url !== 'string') return url;
  return url.replace(
    /\/(?:small|medium|large|xlarge)\/in\/v2\//i,
    '/xxlarge/in/v2/'
  );
}

function uniqPhotos(photos) {
  const seen = new Set();
  const out = [];
  for (const p of photos) {
    const url = upgradePhotoSize(resolveUrl(p, CARSCOM_BASE_URL));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function vehicleIdentityKey(vehicle) {
  const vin = normalizeVin(vehicle?.vin);
  if (vin) return `vin:${vin}`;

  const year = normalizeYear(vehicle?.year);
  const make = cleanText(vehicle?.make)?.toLowerCase();
  const model = cleanText(vehicle?.model)?.toLowerCase();
  if (!year || !make || !model) return null;
  return `ymm:${year}|${make}|${model}`;
}

function parseTitleToParts(title) {
  const clean = cleanText(title);
  if (!clean) return { year: null, make: null, model: null, trim: null };
  const year = normalizeYear(clean);
  if (!year) return { year: null, make: null, model: null, trim: null };
  const rest = clean.replace(String(year), '').replace(/^[\s\-:]+/, '').trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  return {
    year,
    make: tokens[0] || null,
    model: tokens[1] || null,
    trim: tokens.length > 2 ? tokens.slice(2).join(' ') : null,
  };
}

function hasRequiredFields(vehicle) {
  return !!(vehicle.year && vehicle.make && vehicle.model);
}

function toVehicle(raw, feedUrl) {
  const title = raw.name || raw.title || raw.description;
  const titleParts = parseTitleToParts(title);
  const vehicle = createEmptyVehicle();

  vehicle.vin = normalizeVin(
    raw.vin || raw.vehicleIdentificationNumber || raw.sku || raw.productID || raw.mpn || extractVin(title)
  );
  vehicle.year = normalizeYear(raw.year || raw.vehicleModelDate || titleParts.year);
  vehicle.make = cleanText(raw.make || raw.brand?.name || titleParts.make);
  vehicle.model = cleanText(raw.model || raw.modelName || raw.vehicleModel || titleParts.model);
  vehicle.trim = cleanText(raw.trim || raw.variant || titleParts.trim);
  vehicle.price = normalizePrice(raw.price || raw.offers?.price || raw.offers?.[0]?.price);
  vehicle.mileage = normalizeMileage(raw.mileage || raw.miles || raw.odometer);
  vehicle.color = cleanText(raw.color || raw.exteriorColor);
  vehicle.bodyStyle = cleanText(raw.bodyStyle || raw.bodyType);
  vehicle.transmission = cleanText(raw.transmission || raw.transmissionType);
  vehicle.fuelType = cleanText(raw.fuelType || raw.fuel || raw.vehicleEngine?.fuelType);
  vehicle.description = cleanText(raw.description);
  vehicle.photos = uniqPhotos(
    ensureArray(raw.photos || raw.image || raw.images || raw.photoUrls).map((item) =>
      typeof item === 'string' ? item : item?.url || item?.contentUrl
    )
  );
  vehicle.dealerUrl = resolveUrl(raw.url || raw.dealerUrl || feedUrl, feedUrl);
  vehicle.condition = inferCondition(vehicle);

  return vehicle;
}

function dedupe(vehicles) {
  const out = [];
  const seen = new Set();
  for (const vehicle of vehicles) {
    const key = vehicleIdentityKey(vehicle) || `${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(vehicle);
  }
  return out;
}

function ymmKey(vehicle) {
  const year = normalizeYear(vehicle?.year);
  const make = cleanText(vehicle?.make)?.toLowerCase();
  const model = cleanText(vehicle?.model)?.toLowerCase();
  if (!year || !make || !model) return null;
  return `ymm:${year}|${make}|${model}`;
}

function mergeVehicles(primaryVehicles, supplementalVehicles) {
  const merged = [];
  const byKey = new Map();
  // Secondary index: match by year|make|model even when primary used VIN key
  const byYmm = new Map();

  const upsert = (vehicle, primary) => {
    const normalized = {
      ...vehicle,
      photos: uniqPhotos(vehicle.photos || []),
    };
    const key = vehicleIdentityKey(normalized);

    if (!key) {
      merged.push(normalized);
      return;
    }

    const existing = byKey.get(key);
    if (!existing) {
      // For supplementals with no VIN (ymm key), also try matching by ymm
      // against primaries that were stored by VIN key
      if (!primary) {
        const yk = ymmKey(normalized);
        const ymmMatch = yk ? byYmm.get(yk) : null;
        if (ymmMatch) {
          ymmMatch.photos = uniqPhotos([...(ymmMatch.photos || []), ...(normalized.photos || [])]);
          if (!ymmMatch.dealerUrl && normalized.dealerUrl) ymmMatch.dealerUrl = normalized.dealerUrl;
          return;
        }
      }

      byKey.set(key, normalized);
      merged.push(normalized);

      // Also index by ymm for cross-key matching
      const yk = ymmKey(normalized);
      if (yk && !byYmm.has(yk)) byYmm.set(yk, normalized);
      return;
    }

    if (primary) {
      const mergedVehicle = {
        ...normalized,
        photos: uniqPhotos([...(normalized.photos || []), ...(existing.photos || [])]),
      };
      byKey.set(key, mergedVehicle);
      const index = merged.indexOf(existing);
      if (index !== -1) merged[index] = mergedVehicle;

      const yk = ymmKey(mergedVehicle);
      if (yk) byYmm.set(yk, mergedVehicle);
      return;
    }

    existing.photos = uniqPhotos([...(existing.photos || []), ...(normalized.photos || [])]);
    if (!existing.dealerUrl && normalized.dealerUrl) existing.dealerUrl = normalized.dealerUrl;
  };

  primaryVehicles.forEach((vehicle) => upsert(vehicle, true));
  supplementalVehicles.forEach((vehicle) => upsert(vehicle, false));

  return merged;
}

// Cars.com Phoenix LiveView: extract vehicles from data-site-activity vehicleArray
function parseSiteActivityVehicles(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];

  $('[data-site-activity]').each((_, el) => {
    const raw = $(el).attr('data-site-activity');
    if (!raw) return;

    let data;
    try {
      const decoded = raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      data = JSON.parse(decoded);
    } catch {
      return;
    }

    const arr = data.vehicleArray;
    if (!Array.isArray(arr)) return;

    for (const item of arr) {
      const vehicle = createEmptyVehicle();
      vehicle.vin = normalizeVin(item.vin);
      vehicle.year = normalizeYear(item.year);
      vehicle.make = cleanText(item.make);
      vehicle.model = cleanText(item.model);
      vehicle.trim = cleanText(item.trim);
      vehicle.price = normalizePrice(item.price);
      vehicle.mileage = normalizeMileage(item.mileage);
      vehicle.color = cleanText(item.exterior_color);
      vehicle.bodyStyle = cleanText(item.bodystyle);
      vehicle.fuelType = cleanText(item.fuel_type);
      vehicle.transmission = cleanText(item.drivetrain);
      vehicle.description = cleanText(
        `${item.year || ''} ${item.make || ''} ${item.model || ''} ${item.trim || ''}`.trim()
      );
      vehicle.dealerUrl = item.listing_id
        ? resolveUrl(`/vehicledetail/${item.listing_id}/`, CARSCOM_BASE_URL)
        : feedUrl;
      // No photos on search results page — photo_count tells us they exist on detail pages
      vehicle.photos = [];
      vehicle.condition = inferCondition(vehicle);
      if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
    }
  });

  return dedupe(vehicles);
}

// Extract additional vehicle data from shop-card-link elements and title/price/mileage
function parseLiveViewCards(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];

  $('a.shop-card-link[data-override-payload]').each((_, el) => {
    const node = $(el);
    let payload;
    try {
      const raw = node.attr('data-override-payload');
      payload = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    } catch {
      return;
    }

    const vehicle = createEmptyVehicle();
    vehicle.year = normalizeYear(payload.model_year || payload.year);
    vehicle.make = cleanText(payload.make);
    vehicle.model = cleanText(payload.model);
    vehicle.trim = cleanText(payload.trim);
    vehicle.price = normalizePrice(payload.price);
    vehicle.bodyStyle = cleanText(payload.bodystyle);
    vehicle.dealerUrl = node.attr('href')
      ? resolveUrl(node.attr('href'), CARSCOM_BASE_URL)
      : feedUrl;

    // Get title and mileage from sibling elements
    const parent = node.closest('[data-phx-id]').length ? node.closest('[data-phx-id]') : node.parent();
    const title = parent.find('[data-qa="title"]').text().trim();
    if (title && !vehicle.description) vehicle.description = cleanText(title);
    const mileage = parent.find('[data-qa="mileage"]').text().trim();
    if (mileage) vehicle.mileage = normalizeMileage(mileage);

    vehicle.condition = inferCondition(vehicle);
    if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
  });

  return dedupe(vehicles);
}

function parseHtml(html, feedUrl) {
  if (!html) return [];

  // Strategy 1: Extract from data-site-activity vehicleArray (best data source)
  const siteActivityVehicles = parseSiteActivityVehicles(html, feedUrl);

  // Strategy 2: JSON-LD (usually only AutoDealer, not vehicles — but try anyway)
  const jsonLdVehicles = parseJsonLdVehicles(html, feedUrl);

  // Strategy 3: LiveView card links with data-override-payload
  const liveViewVehicles = parseLiveViewCards(html, feedUrl);

  // Strategy 4: Generic HTML card scraping
  const scrapedVehicles = scrapeVehicleCards(html, feedUrl);

  // siteActivity has the most complete structured data (VIN, color, fuel type,
  // drivetrain) but no photo URLs — merge in photos from HTML card scraping.
  let vehicles;
  if (siteActivityVehicles.length > 0) {
    vehicles = mergeVehicles(siteActivityVehicles, scrapedVehicles);
  } else if (jsonLdVehicles.length > 0) {
    vehicles = mergeVehicles(jsonLdVehicles, scrapedVehicles);
  } else if (liveViewVehicles.length > 0) {
    vehicles = mergeVehicles(liveViewVehicles, scrapedVehicles);
  } else {
    vehicles = scrapedVehicles;
  }

  console.log(
    `${LOG_PREFIX} extracted: siteActivity=${siteActivityVehicles.length}, jsonLd=${jsonLdVehicles.length}, liveView=${liveViewVehicles.length}, htmlCards=${scrapedVehicles.length}, merged=${vehicles.length}`
  );
  return vehicles;
}

async function fetchText(feedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(feedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': UA },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonLdVehicles(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];

  $('script[type="application/ld+json"]').each((_, script) => {
    const content = $(script).contents().text();
    if (!content) return;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return;
    }

    const queue = ensureArray(parsed);
    while (queue.length) {
      const node = queue.pop();
      if (!node) continue;

      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }

      if (typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      if (node.itemListElement) queue.push(...ensureArray(node.itemListElement));
      if (node.item) queue.push(...ensureArray(node.item));

      const type = String(node['@type'] || '').toLowerCase();
      if (!type.includes('vehicle') && !type.includes('product')) continue;
      const vehicle = toVehicle(node, feedUrl);
      if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
    }
  });

  return dedupe(vehicles);
}

function scrapeVehicleCards(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];

  const selectors = ['.vehicle-card', '.shop-srp-listings__listing'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const node = $(el);
      const title =
        cleanText(node.find('h2, h3, h4, .title').first().text()) ||
        cleanText(node.attr('aria-label')) ||
        cleanText(node.text());

      // Collect image URLs from multiple attributes — catches lazy-loaded
      // images that only populate data-src, data-original, or srcset
      const photoUrls = [];
      node.find('img').each((_, img) => {
        const imgNode = $(img);
        const src = imgNode.attr('data-src')
          || imgNode.attr('data-original')
          || imgNode.attr('data-lazy-src')
          || imgNode.attr('src');
        if (src) photoUrls.push(src);
      });
      // Also check <source srcset> inside <picture> elements
      node.find('source[srcset]').each((_, source) => {
        const srcset = $(source).attr('srcset') || '';
        for (const part of srcset.split(',')) {
          const src = part.trim().split(/\s+/)[0];
          if (src) photoUrls.push(src);
        }
      });

      const raw = {
        vin: node.attr('data-vin') || extractVin(node.text()),
        title,
        price: node.find('.primary-price, .price').first().text(),
        mileage: node.find('.mileage, .miles').first().text(),
        photos: photoUrls,
        url: node.find('a[href]').first().attr('href'),
      };

      const vehicle = toVehicle(raw, feedUrl);
      if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
    });

    if (vehicles.length > 0) break;
  }

  return dedupe(vehicles);
}

module.exports = {
  async parse(feedUrl) {
    try {
      console.log(`${LOG_PREFIX} parsing ${feedUrl}`);
      const html = await fetchText(feedUrl);
      if (!html) return [];
      return parseHtml(html, feedUrl);
    } catch (error) {
      console.error(`${LOG_PREFIX} parse failed: ${error.message}`);
      return [];
    }
  },

  parseHtml,
};
