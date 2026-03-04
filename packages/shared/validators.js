'use strict';

/**
 * Validate a vehicle object
 * Extracted from inventory-importer.js — zero deps, shared between cloud and desktop.
 *
 * @param {object} vehicle - Vehicle object to validate
 * @returns {object} { valid: boolean, error?: string }
 */
function validateVehicle(vehicle) {
  if (!vehicle) {
    return { valid: false, error: 'Vehicle object is required' };
  }

  // Validate VIN format (17 alphanumeric, no I, O, Q) — or pseudo-VINs (MAN prefix)
  if (!vehicle.vin) {
    return { valid: false, error: 'VIN is required' };
  }
  const isStandardVin = /^[A-HJ-NPR-Z0-9]{17}$/.test(vehicle.vin);
  const isPseudoVin = /^MAN\d+$/.test(vehicle.vin);
  if (!isStandardVin && !isPseudoVin) {
    return { valid: false, error: `Invalid VIN: ${vehicle.vin}` };
  }

  // Validate required fields
  if (!vehicle.make || !vehicle.model) {
    return { valid: false, error: 'Missing required fields: make or model' };
  }

  // Validate year
  const year = Number(vehicle.year);
  if (isNaN(year) || year < 1900 || year > 2030) {
    return { valid: false, error: `Invalid year: ${vehicle.year}` };
  }

  // Validate price (if provided)
  if (vehicle.price != null && vehicle.price <= 0) {
    return { valid: false, error: `Invalid price: ${vehicle.price}` };
  }

  return { valid: true };
}

/**
 * Normalize a vehicle object to consistent field names and types.
 * @param {object} raw - Raw vehicle data from any source
 * @returns {object} Normalized vehicle
 */
function normalizeVehicle(raw) {
  return {
    vin: String(raw.vin || '').toUpperCase().trim(),
    year: parseInt(raw.year, 10) || 0,
    make: String(raw.make || '').trim(),
    model: String(raw.model || '').trim(),
    trim: raw.trim ? String(raw.trim).trim() : null,
    price: raw.price ? parseFloat(raw.price) : null,
    mileage: raw.mileage ? parseInt(raw.mileage, 10) : null,
    color: raw.color || raw.exterior_color || null,
    bodyStyle: raw.bodyStyle || raw.body_style || null,
    transmission: raw.transmission || null,
    fuelType: raw.fuelType || raw.fuel_type || null,
    condition: raw.condition || null,
    description: raw.description || null,
    photos: Array.isArray(raw.photos) ? raw.photos : [],
    dealerUrl: raw.dealerUrl || raw.dealer_url || null,
  };
}

module.exports = { validateVehicle, normalizeVehicle };
