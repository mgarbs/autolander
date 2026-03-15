'use strict';

const crypto = require('crypto');
const express = require('express');

module.exports = function createVehiclesRouter(prisma) {
  const router = express.Router();

  function normalizePhotos(photos) {
    if (!Array.isArray(photos)) return [];
    return Array.from(new Set(
      photos
        .map((photo) => (typeof photo === 'string' ? photo.trim() : ''))
        .filter(Boolean)
    ));
  }

  function mergeStaleReasons(existingReason, nextReason) {
    const reasons = new Set(
      String(existingReason || '')
        .split(',')
        .map((reason) => reason.trim())
        .filter(Boolean)
    );
    reasons.add(nextReason);
    return Array.from(reasons).join(',');
  }

  router.get('/stats/summary', async (req, res) => {
    const orgId = req.orgId;
    const [total, posted, active, stale] = await Promise.all([
      prisma.vehicle.count({ where: { orgId, status: 'ACTIVE' } }),
      prisma.vehicle.count({ where: { orgId, fbPosted: true } }),
      prisma.conversation.count({ where: { orgId, state: { notIn: ['CLOSED_WON', 'CLOSED_LOST', 'STALE'] } } }),
      prisma.vehicle.count({ where: { orgId, fbPosted: true, fbStale: true, status: 'ACTIVE' } }),
    ]);
    res.json({ vehicles: total, posted, activeLeads: active, stale });
  });

  router.get('/', async (req, res) => {
    const { status, search, limit = '1000', offset = '0', feedId, missingPhotos } = req.query;
    const where = { orgId: req.orgId };
    if (status) where.status = status;
    if (feedId) where.feedId = feedId;
    if (missingPhotos === 'true') {
      where.photos = { isEmpty: true };
    }
    if (req.query.fbPosted !== undefined) {
      where.fbPosted = req.query.fbPosted === 'true';
    }
    if (req.query.fbStale !== undefined) {
      where.fbStale = req.query.fbStale === 'true';
    }
    if (search) {
      where.OR = [
        { vin: { contains: search, mode: 'insensitive' } },
        { make: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [vehicles, total] = await Promise.all([
      prisma.vehicle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.vehicle.count({ where }),
    ]);

    res.json({ vehicles, total });
  });

  // Mark a vehicle as posted to Facebook
  router.put('/mark-posted', async (req, res) => {
    const { vehicleId, vin, postUrl, postId, postedAt } = req.body;
    if (!vehicleId && !vin) {
      return res.status(400).json({ error: 'vehicleId or vin is required.' });
    }

    const where = { orgId: req.orgId };
    if (vehicleId) {
      where.id = vehicleId;
    } else {
      where.vin = vin;
    }

    const vehicle = await prisma.vehicle.findFirst({ where });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

    const updated = await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: {
        fbPosted: true,
        fbPostDate: postedAt ? new Date(postedAt) : new Date(),
        fbListingUrl: postUrl || null,
        fbListingId: postId || null,
        fbPostedPrice: vehicle.price,
        fbPostedPhotosHash: crypto
          .createHash('sha256')
          .update(JSON.stringify(vehicle.photos || []))
          .digest('hex'),
        fbPostedDescription: vehicle.description || null,
        fbStale: false,
        fbStaleReason: null,
        fbStaleSince: null,
      },
    });

    res.json({ success: true, vehicle: updated });
  });

  router.put('/:id/mark-updated', async (req, res) => {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

    const updated = await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: {
        fbPostedPrice: vehicle.price,
        fbPostedPhotosHash: crypto
          .createHash('sha256')
          .update(JSON.stringify(vehicle.photos || []))
          .digest('hex'),
        fbPostedDescription: vehicle.description || null,
        fbStale: false,
        fbStaleReason: null,
        fbStaleSince: null,
      },
    });

    res.json({ success: true, vehicle: updated });
  });

  router.put('/:id/mark-sold', async (req, res) => {
    const result = await prisma.vehicle.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data: {
        status: 'SOLD',
        fbPosted: false,
        fbStale: false,
        fbStaleReason: null,
        fbStaleSince: null,
      },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ success: true });
  });

  router.put('/:id/photos', async (req, res) => {
    const { photos } = req.body;
    if (!Array.isArray(photos)) {
      return res.status(400).json({ error: 'photos must be array' });
    }

    const vehicle = await prisma.vehicle.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

    const normalizedPhotos = normalizePhotos(photos);
    const data = { photos: normalizedPhotos };

    if (vehicle.fbPosted && vehicle.fbPostedPhotosHash) {
      const nextHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(normalizedPhotos))
        .digest('hex');

      if (nextHash !== vehicle.fbPostedPhotosHash) {
        data.fbStale = true;
        data.fbStaleReason = mergeStaleReasons(vehicle.fbStaleReason, 'photos_changed');
        data.fbStaleSince = vehicle.fbStaleSince || new Date();
      }
    }

    const updated = await prisma.vehicle.update({
      where: { id: vehicle.id },
      data,
    });

    res.json({ success: true, vehicle: updated });
  });

  router.get('/:id', async (req, res) => {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
      include: { priceHistory: { orderBy: { recordedAt: 'desc' }, take: 10 } },
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json(vehicle);
  });

  router.post('/', async (req, res) => {
    const { vin, year, make, model, trim, price, mileage, color, bodyStyle,
            transmission, fuelType, condition, description, photos, dealerUrl } = req.body;

    if (!vin || !year || !make || !model) {
      return res.status(400).json({ error: 'vin, year, make, and model are required.' });
    }

    try {
      const vehicle = await prisma.vehicle.create({
        data: {
          orgId: req.orgId, vin: vin.toUpperCase(), year: parseInt(year),
          make, model, trim, price: price ? parseFloat(price) : null,
          mileage: mileage ? parseInt(mileage) : null, color, bodyStyle,
          transmission, fuelType, condition, description,
          photos: photos || [], dealerUrl,
        },
      });
      res.status(201).json(vehicle);
    } catch (err) {
      if (err.code === 'P2002') {
        return res.status(409).json({ error: `Vehicle with VIN ${vin} already exists in this org.` });
      }
      throw err;
    }
  });

  router.put('/:id', async (req, res) => {
    const { price, status, photos, generatedTitle, generatedDescription, fbPosted, fbPostDate, ...rest } = req.body;
    const data = { ...rest };
    if (price !== undefined) data.price = parseFloat(price);
    if (status) data.status = status;
    if (photos !== undefined) data.photos = photos;
    if (generatedTitle !== undefined) data.generatedTitle = generatedTitle;
    if (generatedDescription !== undefined) data.generatedDescription = generatedDescription;
    if (fbPosted !== undefined) data.fbPosted = fbPosted;
    if (fbPostDate) data.fbPostDate = new Date(fbPostDate);

    if (price !== undefined) {
      const existing = await prisma.vehicle.findFirst({ where: { id: req.params.id, orgId: req.orgId } });
      if (existing && existing.price !== parseFloat(price)) {
        await prisma.priceHistory.create({
          data: { vehicleId: req.params.id, price: parseFloat(price), previousPrice: existing.price },
        });
      }
    }

    const vehicle = await prisma.vehicle.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data,
    });
    if (vehicle.count === 0) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ success: true });
  });

  router.delete('/:id', async (req, res) => {
    const result = await prisma.vehicle.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data: { status: 'ARCHIVED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ success: true });
  });

  return router;
};
