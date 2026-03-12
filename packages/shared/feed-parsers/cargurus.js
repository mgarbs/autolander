'use strict';

const cheerio = require('cheerio');
const { createEmptyVehicle } = require('./schema');

const LOG_PREFIX = '[feed-parser:cargurus]';
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
const ENTITY_REGEX = /sp\d+/i;

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

function hasRequiredFields(v) {
  return !!(v.year && v.make && v.model);
}

function extractEntityId(feedUrl) {
  if (!feedUrl) return null;
  try {
    const url = new URL(feedUrl);
    const sel = url.searchParams.get('entitySelectingHelper.selectedEntity');
    if (sel && ENTITY_REGEX.test(sel)) return sel.match(ENTITY_REGEX)[0].toLowerCase();
  } catch {}
  const m = String(feedUrl).match(ENTITY_REGEX);
  return m ? m[0].toLowerCase() : null;
}

function dedupe(vehicles) {
  const out = [];
  const seen = new Set();
  for (const v of vehicles) {
    const key = v.vin || `${v.year}|${v.make}|${v.model}|${v.price || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// Extract balanced JSON object starting at given position
function extractBalancedJson(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  let end = -1;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return end > startIdx ? text.substring(startIdx, end) : null;
}

// Convert a Remix-format vehicle tile (nested ontologyData, priceData, etc.) to our schema
function remixTileToVehicle(raw, entityId, feedUrl) {
  const v = createEmptyVehicle();
  const ont = raw.ontologyData || {};
  v.vin = normalizeVin(raw.vin);
  v.year = normalizeYear(ont.carYear);
  v.make = cleanText(ont.makeName);
  v.model = cleanText(ont.modelName);
  v.trim = cleanText(raw.trimName || ont.trimName || (raw.listingTitle || '').replace(/^\d{4}\s+\S+\s+\S+\s*/, ''));
  v.price = normalizePrice(raw.priceData?.current || raw.priceData?.price || raw.priceData?.listPrice);
  v.mileage = normalizeMileage(raw.mileageData?.value);
  v.color = cleanText(raw.exteriorColorData?.normalized || raw.exteriorColorData?.name);
  v.bodyStyle = cleanText(ont.bodyTypeName);
  v.transmission = cleanText(raw.localizedTransmission);
  v.fuelType = cleanText(raw.fuelData?.localizedType);
  v.description = cleanText(raw.listingTitle);
  v.photos = raw.pictureData?.url ? [raw.pictureData.url] : [];
  v.dealerUrl = raw.id && entityId
    ? `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?entitySelectingHelper.selectedEntity=${entityId}#listing=${raw.id}`
    : feedUrl;
  return v;
}

// Convert a flat-format vehicle (from __remixContext.r recommendations or old API) to our schema
function flatToVehicle(raw, entityId, feedUrl) {
  const v = createEmptyVehicle();
  v.vin = normalizeVin(raw.vin);
  v.year = normalizeYear(raw.year || raw.carYear);
  v.make = cleanText(raw.make || raw.makeName);
  v.model = cleanText(raw.model || raw.modelName);
  v.trim = cleanText(raw.trim || raw.trimName);
  v.price = normalizePrice(raw.price || raw.expectedPrice);
  v.mileage = normalizeMileage(raw.mileage);
  v.color = cleanText(raw.exteriorColor || raw.normalizedExteriorColor);
  v.bodyStyle = cleanText(raw.bodyTypeName);
  v.transmission = cleanText(raw.localizedTransmission);
  v.fuelType = cleanText(raw.localizedFuelType || raw.fuelType);
  v.description = cleanText(raw.listingTitle);
  v.photos = raw.imageUrl ? [raw.imageUrl] : (raw.originalPictureData?.url ? [raw.originalPictureData.url] : []);
  v.dealerUrl = raw.id && entityId
    ? `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?entitySelectingHelper.selectedEntity=${entityId}#listing=${raw.id}`
    : feedUrl;
  return v;
}

function extractFromHtml(html, feedUrl) {
  const $ = cheerio.load(html);
  const vehicles = [];
  const entityId = extractEntityId(feedUrl);

  // Strategy 1: Parse window.__remixContext = {...} (CarGurus Remix app)
  // Vehicle tiles at: state.loaderData["routes/..."].search.tiles[N].data
  $('script').each((_, script) => {
    const text = $(script).html() || '';
    if (!text.startsWith('window.__remixContext')) return;

    const braceIdx = text.indexOf('{');
    if (braceIdx === -1) return;
    const jsonStr = extractBalancedJson(text, braceIdx);
    if (!jsonStr) return;

    try {
      const ctx = JSON.parse(jsonStr);
      // Walk to find objects with vin + ontologyData (Remix tile format)
      const walk = (obj, depth) => {
        if (depth > 25 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((item) => walk(item, depth + 1)); return; }
        if (obj.vin && obj.ontologyData) {
          const v = remixTileToVehicle(obj, entityId, feedUrl);
          if (hasRequiredFields(v)) vehicles.push(v);
          return;
        }
        for (const val of Object.values(obj)) {
          if (val && typeof val === 'object') walk(val, depth + 1);
        }
      };
      walk(ctx, 0);
      if (vehicles.length > 0) {
        console.log(`${LOG_PREFIX} found ${vehicles.length} vehicles in __remixContext`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} failed to parse __remixContext: ${e.message.substring(0, 100)}`);
    }
  });

  // Strategy 2: Parse __remixContext.r() calls (recommendations with flat format)
  $('script').each((_, script) => {
    const text = $(script).html() || '';
    if (!text.includes('__remixContext.r(')) return;

    // Extract JSON arrays from the script
    const bracketIdx = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (bracketIdx === -1 || lastBracket <= bracketIdx) return;

    try {
      const data = JSON.parse(text.substring(bracketIdx, lastBracket + 1));
      if (!Array.isArray(data)) return;
      for (const raw of data) {
        if (!raw.vin || !(raw.year || raw.carYear)) continue;
        const v = flatToVehicle(raw, entityId, feedUrl);
        if (hasRequiredFields(v)) vehicles.push(v);
      }
      console.log(`${LOG_PREFIX} found ${data.length} items in __remixContext.r()`);
    } catch {}
  });

  return dedupe(vehicles);
}

module.exports = {
  // Called when HTML is pre-fetched by Electron's hidden BrowserWindow
  parseHtml(html, feedUrl) {
    console.log(`${LOG_PREFIX} parsing pre-fetched HTML (${html.length} bytes)`);
    const vehicles = extractFromHtml(html, feedUrl);
    console.log(`${LOG_PREFIX} extracted ${vehicles.length} vehicles from HTML`);
    return vehicles;
  },

  // Called for server-side fetch (will fail for CarGurus due to bot protection)
  async parse(feedUrl) {
    console.log(`${LOG_PREFIX} server-side parse not supported (bot protection). Use parseHtml with pre-fetched HTML.`);
    return [];
  },
};
