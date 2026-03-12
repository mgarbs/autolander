'use strict';

const { parseFeed } = require('@autolander/shared/feed-parsers');

function toStringOrNull(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function toFloatOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.map(toStringOrNull).filter(Boolean);
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeVehicle(vehicle) {
  return {
    vin: toStringOrNull(vehicle.vin),
    year: toIntOrNull(vehicle.year),
    make: toStringOrNull(vehicle.make),
    model: toStringOrNull(vehicle.model),
    trim: toStringOrNull(vehicle.trim),
    price: toFloatOrNull(vehicle.price),
    mileage: toIntOrNull(vehicle.mileage),
    color: toStringOrNull(vehicle.color),
    bodyStyle: toStringOrNull(vehicle.bodyStyle),
    transmission: toStringOrNull(vehicle.transmission),
    fuelType: toStringOrNull(vehicle.fuelType),
    condition: toStringOrNull(vehicle.condition),
    description: toStringOrNull(vehicle.description),
    photos: normalizePhotos(vehicle.photos),
    dealerUrl: toStringOrNull(vehicle.dealerUrl),
  };
}

module.exports = {
  async syncFeed(feed, prisma) {
    const parsedVehicles = await parseFeed(feed.feedUrl, feed.feedType);
    return processVehicles(feed, parsedVehicles, prisma);
  },

  async syncFeedWithVehicles(feed, parsedVehicles, prisma) {
    return processVehicles(feed, parsedVehicles, prisma);
  },
};

async function processVehicles(feed, parsedVehicles, prisma) {
  const startedAt = new Date();
  const errors = [];
  let vehiclesFound = 0;
  let vehiclesAdded = 0;
  let vehiclesUpdated = 0;
  let syncLog = null;

  console.log(`[feed-sync] Starting sync for feed ${feed.id}`);

  try {
    syncLog = await prisma.feedSyncLog.create({
      data: {
        feedId: feed.id,
        startedAt,
      },
    });

    vehiclesFound = Array.isArray(parsedVehicles) ? parsedVehicles.length : 0;
    const seenVins = new Set();

    for (const rawVehicle of parsedVehicles || []) {
      const vehicle = normalizeVehicle(rawVehicle || {});
      const hasIdentity = Boolean(vehicle.vin) && Boolean(vehicle.year && vehicle.make && vehicle.model);

      if (!hasIdentity) {
        continue;
      }
      seenVins.add(vehicle.vin);

      try {
        const existing = await prisma.vehicle.findFirst({
          where: {
            orgId: feed.orgId,
            vin: vehicle.vin,
          },
        });

        if (!existing) {
          await prisma.vehicle.create({
            data: {
              orgId: feed.orgId,
              feedId: feed.id,
              vin: vehicle.vin,
              year: vehicle.year,
              make: vehicle.make,
              model: vehicle.model,
              trim: vehicle.trim,
              price: vehicle.price,
              mileage: vehicle.mileage,
              color: vehicle.color,
              bodyStyle: vehicle.bodyStyle,
              transmission: vehicle.transmission,
              fuelType: vehicle.fuelType,
              condition: vehicle.condition,
              description: vehicle.description,
              photos: vehicle.photos,
              dealerUrl: vehicle.dealerUrl,
              status: 'ACTIVE',
            },
          });
          vehiclesAdded += 1;
          continue;
        }

        const changedFields = {};
        const fieldsToCompare = [
          'year', 'make', 'model', 'trim', 'price', 'mileage', 'color',
          'bodyStyle', 'transmission', 'fuelType', 'condition', 'description', 'dealerUrl',
        ];

        for (const field of fieldsToCompare) {
          if (existing[field] !== vehicle[field]) {
            changedFields[field] = vehicle[field];
          }
        }

        if (!arraysEqual(existing.photos || [], vehicle.photos || [])) {
          changedFields.photos = vehicle.photos;
        }

        if (existing.feedId !== feed.id) {
          changedFields.feedId = feed.id;
        }

        if (existing.status !== 'ACTIVE') {
          changedFields.status = 'ACTIVE';
        }

        const priceChanged = existing.price !== vehicle.price;
        if (priceChanged && vehicle.price !== null) {
          await prisma.priceHistory.create({
            data: {
              vehicleId: existing.id,
              price: vehicle.price,
              previousPrice: existing.price,
            },
          });
        }

        if (Object.keys(changedFields).length > 0) {
          await prisma.vehicle.update({
            where: { id: existing.id },
            data: changedFields,
          });
          vehiclesUpdated += 1;
        }
      } catch (vehicleError) {
        const message = `[feed-sync] Vehicle sync error for feed ${feed.id}, VIN ${vehicle.vin}: ${vehicleError.message}`;
        console.error(message);
        errors.push(message);
      }
    }

    const seenVinList = Array.from(seenVins);
    if (seenVinList.length > 0) {
      await prisma.vehicle.updateMany({
        where: {
          orgId: feed.orgId,
          feedId: feed.id,
          vin: { notIn: seenVinList },
          status: { not: 'ARCHIVED' },
          fbPosted: true,
        },
        data: { status: 'ARCHIVED' },
      });
    } else {
      await prisma.vehicle.updateMany({
        where: {
          orgId: feed.orgId,
          feedId: feed.id,
          status: { not: 'ARCHIVED' },
          fbPosted: true,
        },
        data: { status: 'ARCHIVED' },
      });
    }

    await prisma.inventoryFeed.update({
      where: { id: feed.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: errors.length ? 'PARTIAL_SUCCESS' : 'SUCCESS',
        vehicleCount: vehiclesFound,
      },
    });

    await prisma.feedSyncLog.update({
      where: { id: syncLog.id },
      data: {
        completedAt: new Date(),
        vehiclesFound,
        vehiclesAdded,
        vehiclesUpdated,
        error: errors.length ? errors.join('\n').slice(0, 5000) : null,
      },
    });

    console.log(
      `[feed-sync] Completed sync for feed ${feed.id}: found=${vehiclesFound}, added=${vehiclesAdded}, updated=${vehiclesUpdated}, errors=${errors.length}`
    );
    return { vehiclesFound, vehiclesAdded, vehiclesUpdated, errors };
  } catch (error) {
    console.error(`[feed-sync] Sync failed for feed ${feed.id}: ${error.message}`);

    if (syncLog) {
      await prisma.feedSyncLog.update({
        where: { id: syncLog.id },
        data: {
          completedAt: new Date(),
          vehiclesFound,
          vehiclesAdded,
          vehiclesUpdated,
          error: String(error.message || error).slice(0, 5000),
        },
      });
    }

    await prisma.inventoryFeed.update({
      where: { id: feed.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: 'FAILED',
      },
    });

    throw error;
  }
}
