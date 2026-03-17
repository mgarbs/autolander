'use strict';

/**
 * Normalized vehicle schema for feed parsers.
 * All parsers must return objects matching this shape.
 */
const VEHICLE_SCHEMA_FIELDS = [
  'vin', 'year', 'make', 'model', 'trim', 'price', 'mileage',
  'color', 'bodyStyle', 'transmission', 'fuelType', 'condition',
  'description', 'photos', 'dealerUrl',
];

function createEmptyVehicle() {
  return {
    vin: null,
    year: null,
    make: null,
    model: null,
    trim: null,
    price: null,
    mileage: null,
    color: null,
    bodyStyle: null,
    transmission: null,
    fuelType: null,
    condition: null,
    description: null,
    photos: [],
    dealerUrl: null,
  };
}

/**
 * Infer FB Marketplace condition from year and mileage.
 *
 * Called after parsing so the condition is set at the source — the poster
 * just trusts whatever value is here without needing its own inference.
 *
 * Feed-provided values like "used", "pre-owned", or "certified" are too
 * vague for FB's dropdown (Excellent / Very Good / Good / Fair / Poor),
 * so we always compute from the actual data.
 */
function inferCondition(vehicle) {
  const currentYear = new Date().getFullYear();
  const age = currentYear - (vehicle.year || currentYear);
  const miles = vehicle.mileage || 0;

  if (age <= 2 && miles < 30000) return 'Excellent';
  if (age <= 5 || miles < 60000) return 'Very Good';
  if (age <= 10 || miles < 100000) return 'Good';
  if (miles < 150000) return 'Fair';
  return 'Poor';
}

module.exports = { VEHICLE_SCHEMA_FIELDS, createEmptyVehicle, inferCondition };
