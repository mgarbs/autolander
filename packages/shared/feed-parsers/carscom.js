'use strict';

const cheerio = require('cheerio');
const { createEmptyVehicle } = require('./schema');

const LOG_PREFIX = '[feed-parser:carscom]';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REQUEST_TIMEOUT_MS = 30000;
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

function uniqPhotos(photos) {
  const seen = new Set();
  const out = [];
  for (const p of photos) {
    const url = cleanText(p);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
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
  vehicle.condition = cleanText(raw.condition || raw.itemCondition);
  vehicle.description = cleanText(raw.description);
  vehicle.photos = uniqPhotos(
    ensureArray(raw.photos || raw.image || raw.images || raw.photoUrls).map((item) =>
      typeof item === 'string' ? item : item?.url || item?.contentUrl
    )
  );
  vehicle.dealerUrl = cleanText(raw.url || raw.dealerUrl || feedUrl);

  return vehicle;
}

function dedupe(vehicles) {
  const out = [];
  const seen = new Set();
  for (const vehicle of vehicles) {
    const key = vehicle.vin || `${vehicle.year}|${vehicle.make}|${vehicle.model}|${vehicle.price || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(vehicle);
  }
  return out;
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

      const raw = {
        vin: node.attr('data-vin') || extractVin(node.text()),
        title,
        price: node.find('.primary-price, .price').first().text(),
        mileage: node.find('.mileage, .miles').first().text(),
        photos: node
          .find('img[src], img[data-src]')
          .map((i, img) => $(img).attr('data-src') || $(img).attr('src'))
          .get(),
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

      const jsonLdVehicles = parseJsonLdVehicles(html, feedUrl);
      if (jsonLdVehicles.length) {
        console.log(`${LOG_PREFIX} extracted ${jsonLdVehicles.length} vehicles via JSON-LD`);
        return jsonLdVehicles;
      }

      const scrapedVehicles = scrapeVehicleCards(html, feedUrl);
      console.log(`${LOG_PREFIX} extracted ${scrapedVehicles.length} vehicles via HTML`);
      return scrapedVehicles;
    } catch (error) {
      console.error(`${LOG_PREFIX} parse failed: ${error.message}`);
      return [];
    }
  },
};
