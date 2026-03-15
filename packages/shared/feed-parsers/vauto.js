'use strict';

const cheerio = require('cheerio');
const { createEmptyVehicle } = require('./schema');

const LOG_PREFIX = '[feed-parser:vauto]';

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
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) ? vin : null;
}

function hasRequiredFields(v) {
  return !!(v.year && v.make && v.model);
}

/**
 * Parse CSV text into array of objects using header row as keys.
 * Handles quoted fields with commas inside them.
 */
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Parse a single CSV line respecting quoted fields
  function parseLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.length < 3) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] || null; });
    rows.push(obj);
  }
  return rows;
}

/**
 * Map a vAuto record (from CSV or XML) to our normalized vehicle schema.
 * vAuto common column names: VIN, Year, Make, Model, Trim, Price, Mileage/Miles,
 * Ext_Color/ExteriorColor, Body/BodyStyle, Transmission, FuelType, Description,
 * ImageURLs/PhotoURLs (pipe-delimited), DealerURL/VDP_URL
 */
function mapToVehicle(raw) {
  const v = createEmptyVehicle();
  v.vin = normalizeVin(raw.vin || raw.vehicle_vin || raw.stockvin);
  v.year = normalizeYear(raw.year || raw.vehicle_year || raw.modelyear);
  v.make = cleanText(raw.make || raw.vehicle_make);
  v.model = cleanText(raw.model || raw.vehicle_model);
  v.trim = cleanText(raw.trim || raw.vehicle_trim || raw.trimlevel);
  v.price = normalizePrice(raw.price || raw.selling_price || raw.internet_price || raw.askingprice || raw.msrp);
  v.mileage = normalizeMileage(raw.mileage || raw.miles || raw.odometer);
  v.color = cleanText(raw.ext_color || raw.exteriorcolor || raw.exterior_color || raw.color);
  v.bodyStyle = cleanText(raw.body || raw.bodystyle || raw.body_style || raw.bodytype);
  v.transmission = cleanText(raw.transmission || raw.trans);
  v.fuelType = cleanText(raw.fueltype || raw.fuel_type || raw.fuel);
  v.condition = cleanText(raw.condition || raw.certified);
  v.description = cleanText(raw.description || raw.comments || raw.vehicle_comments || raw.sellernotes);

  const photoStr = raw.imageurls || raw.photourls || raw.photo_urls || raw.images || raw.image_list || '';
  if (photoStr) {
    v.photos = String(photoStr).split('|').map((u) => u.trim()).filter(Boolean);
  }

  v.dealerUrl = cleanText(raw.dealerurl || raw.vdp_url || raw.detail_url || raw.vehicle_url);
  return v;
}

function parseXml(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const vehicles = [];

  const vehicleSelectors = ['vehicle', 'Vehicle', 'listing', 'Listing', 'item', 'Item'];
  let vehicleEls = [];
  for (const sel of vehicleSelectors) {
    vehicleEls = $(sel);
    if (vehicleEls.length > 0) break;
  }

  vehicleEls.each((_, el) => {
    const raw = {};
    $(el).children().each((_, child) => {
      const tag = child.tagName?.toLowerCase().replace(/[^a-z0-9_]/g, '_') || '';
      if (tag) {
        raw[tag] = $(child).text().trim();
      }
    });
    const v = mapToVehicle(raw);
    if (hasRequiredFields(v)) vehicles.push(v);
  });

  return vehicles;
}

module.exports = {
  parseHtml(html, feedUrl) {
    console.log(`${LOG_PREFIX} parsing pre-fetched content (${html.length} bytes)`);
    const trimmed = html.trimStart();
    let vehicles;
    if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
      vehicles = parseXml(html);
    } else {
      const rows = parseCSV(html);
      vehicles = rows.map(mapToVehicle).filter(hasRequiredFields);
    }
    console.log(`${LOG_PREFIX} extracted ${vehicles.length} vehicles`);
    return vehicles;
  },

  async parse(feedUrl) {
    console.log(`${LOG_PREFIX} fetching feed from ${feedUrl}`);
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    try {
      const res = await fetch(feedUrl, { timeout: 30000 });
      if (!res.ok) {
        console.error(`${LOG_PREFIX} fetch failed: ${res.status}`);
        return [];
      }
      const text = await res.text();
      return module.exports.parseHtml(text, feedUrl);
    } catch (err) {
      console.error(`${LOG_PREFIX} parse error: ${err.message}`);
      return [];
    }
  },
};
