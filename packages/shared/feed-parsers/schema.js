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

module.exports = { VEHICLE_SCHEMA_FIELDS, createEmptyVehicle };
