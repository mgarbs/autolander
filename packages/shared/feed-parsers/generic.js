'use strict';

const cheerio = require('cheerio');
const { createEmptyVehicle } = require('./schema');

const LOG_PREFIX = '[feed-parser:generic]';
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

function normalizeMileage(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const numeric = String(value).replace(/[^\d]/g, '');
  if (!numeric) return null;
  const parsed = Number.parseInt(numeric, 10);
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
  const make = tokens[0] || null;
  const model = tokens[1] || null;
  const trim = tokens.length > 2 ? tokens.slice(2).join(' ') : null;
  return { year, make, model, trim };
}

function hasRequiredFields(vehicle) {
  return !!(vehicle.year && vehicle.make && vehicle.model);
}

function toVehicle(raw, defaults = {}) {
  const title = raw.name || raw.title || raw.vehicleTitle || raw.headline || raw.description;
  const titleParts = parseTitleToParts(title);
  const vehicle = createEmptyVehicle();

  vehicle.vin = normalizeVin(
    raw.vin ||
      raw.vehicleIdentificationNumber ||
      raw.vehicle_id ||
      raw.stockVin ||
      raw.sku ||
      extractVin(raw.text || title || '')
  );
  vehicle.year = normalizeYear(raw.year || raw.vehicleModelDate || titleParts.year);
  vehicle.make = cleanText(raw.make || raw.brand?.name || raw.manufacturer || titleParts.make);
  vehicle.model = cleanText(raw.model || raw.modelName || raw.vehicleModel || titleParts.model);
  vehicle.trim = cleanText(raw.trim || raw.vehicleTrim || raw.variant || titleParts.trim);
  vehicle.price = normalizePrice(
    raw.price || raw.offers?.price || raw.offers?.[0]?.price || raw.salePrice
  );
  vehicle.mileage = normalizeMileage(
    raw.mileage || raw.odometer || raw.miles || raw.mileageFromOdometer?.value
  );
  vehicle.color = cleanText(raw.color || raw.exteriorColor || raw.exterior_color);
  vehicle.bodyStyle = cleanText(raw.bodyStyle || raw.body_type || raw.bodyType);
  vehicle.transmission = cleanText(raw.transmission || raw.transmissionType);
  vehicle.fuelType = cleanText(raw.fuelType || raw.fuel || raw.vehicleEngine?.fuelType);
  vehicle.condition = cleanText(raw.condition || raw.itemCondition);
  vehicle.description = cleanText(raw.description);
  vehicle.photos = uniqPhotos(
    ensureArray(
      raw.photos ||
        raw.images ||
        raw.image ||
        raw.photoUrls ||
        raw.imageUrl ||
        raw.photoUrl
    ).map((item) => (typeof item === 'string' ? item : item?.url || item?.contentUrl))
  );
  vehicle.dealerUrl = cleanText(raw.url || raw.dealerUrl || defaults.dealerUrl);

  return vehicle;
}

function extractJsonLdVehicles(html, feedUrl) {
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

    const nodes = [];
    const stack = ensureArray(parsed);
    while (stack.length) {
      const next = stack.pop();
      if (!next) continue;
      if (Array.isArray(next)) {
        stack.push(...next);
        continue;
      }
      if (typeof next !== 'object') continue;
      nodes.push(next);
      if (Array.isArray(next['@graph'])) stack.push(...next['@graph']);
      if (next.itemListElement) stack.push(...ensureArray(next.itemListElement));
      if (next.item) stack.push(...ensureArray(next.item));
    }

    for (const node of nodes) {
      const type = String(node['@type'] || '').toLowerCase();
      if (!type.includes('vehicle') && !type.includes('product') && !type.includes('car')) continue;
      const raw = node.item && typeof node.item === 'object' ? node.item : node;
      const vehicle = toVehicle(raw, { dealerUrl: feedUrl });
      if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
    }
  });

  return dedupeVehicles(vehicles);
}

function extractXmlVehicles(xml, feedUrl) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const vehicles = [];

  $('vehicle, listing, item, car').each((_, el) => {
    const node = $(el);
    const raw = {
      vin: node.find('vin, VIN, vehicleid, vehicle_id').first().text(),
      year: node.find('year, Year').first().text(),
      make: node.find('make, Make').first().text(),
      model: node.find('model, Model').first().text(),
      trim: node.find('trim, Trim').first().text(),
      price: node.find('price, Price, internet_price, asking_price').first().text(),
      mileage: node.find('mileage, odometer, miles').first().text(),
      color: node.find('color, exterior_color').first().text(),
      bodyStyle: node.find('body_style, bodystyle, body').first().text(),
      transmission: node.find('transmission').first().text(),
      fuelType: node.find('fuel, fuel_type').first().text(),
      condition: node.find('condition').first().text(),
      description: node.find('description, comments').first().text(),
      photos: node.find('photo, image, img, picture, media').map((i, p) => $(p).text()).get(),
      url: node.find('url, link').first().text(),
    };
    const vehicle = toVehicle(raw, { dealerUrl: feedUrl });
    if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
  });

  return dedupeVehicles(vehicles);
}

function extractHtmlVehicles(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];
  const selectors = ['[data-vin]', '.vehicle-card', '.inventory-listing', '.srp-listing'];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const node = $(el);
      const title =
        node.find('h1, h2, h3, h4, .title, .vehicle-title').first().text() || node.text();
      const raw = {
        vin: node.attr('data-vin') || extractVin(node.text()),
        title,
        price: node.find('.primary-price, .price, [data-price]').first().text(),
        mileage: node.find('.mileage, .odometer, [data-mileage]').first().text(),
        photos: node
          .find('img')
          .map((i, img) => $(img).attr('data-src') || $(img).attr('src'))
          .get(),
        url: node.find('a[href]').first().attr('href'),
        description: cleanText(node.find('.description').first().text()),
      };
      const vehicle = toVehicle(raw, { dealerUrl: feedUrl });
      if (hasRequiredFields(vehicle)) vehicles.push(vehicle);
    });

    if (vehicles.length > 0) break;
  }

  return dedupeVehicles(vehicles);
}

function dedupeVehicles(vehicles) {
  const seen = new Set();
  const out = [];
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
    const text = await response.text();
    return {
      text,
      contentType: (response.headers.get('content-type') || '').toLowerCase(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  async parse(feedUrl) {
    try {
      console.log(`${LOG_PREFIX} parsing ${feedUrl}`);
      const { text, contentType } = await fetchText(feedUrl);
      if (!text) return [];

      const fromJsonLd = extractJsonLdVehicles(text, feedUrl);
      if (fromJsonLd.length) {
        console.log(`${LOG_PREFIX} extracted ${fromJsonLd.length} vehicles via JSON-LD`);
        return fromJsonLd;
      }

      const looksXml = contentType.includes('xml') || /^\s*<\?xml/i.test(text);
      if (looksXml) {
        const fromXml = extractXmlVehicles(text, feedUrl);
        if (fromXml.length) {
          console.log(`${LOG_PREFIX} extracted ${fromXml.length} vehicles via XML`);
          return fromXml;
        }
      }

      const fromHtml = extractHtmlVehicles(text, feedUrl);
      console.log(`${LOG_PREFIX} extracted ${fromHtml.length} vehicles via HTML`);
      return fromHtml;
    } catch (error) {
      console.error(`${LOG_PREFIX} parse failed: ${error.message}`);
      return [];
    }
  },
};
