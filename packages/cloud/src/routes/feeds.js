'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');
const feedSync = require('../services/feed-sync');

module.exports = function createFeedsRouter(prisma) {
  const router = express.Router();

  // List all feeds for org
  router.get('/', async (req, res) => {
    const feeds = await prisma.inventoryFeed.findMany({
      where: { orgId: req.orgId },
      include: {
        syncLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ feeds });
  });

  // Create a new feed
  router.post('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const { feedUrl, feedType, name, syncScheduleCron } = req.body;
    if (!feedUrl) return res.status(400).json({ error: 'feedUrl is required.' });

    const detectedType = feedType || detectFeedType(feedUrl);

    const feed = await prisma.inventoryFeed.create({
      data: {
        orgId: req.orgId,
        feedUrl,
        feedType: detectedType,
        name: name || null,
        syncScheduleCron: syncScheduleCron || '0 */6 * * *',
      },
    });
    res.status(201).json(feed);
  });

  // Update a feed
  router.put('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const { feedUrl, feedType, name, syncScheduleCron, enabled } = req.body;
    const data = {};
    if (feedUrl) data.feedUrl = feedUrl;
    if (feedType) data.feedType = feedType;
    if (name !== undefined) data.name = name;
    if (syncScheduleCron) data.syncScheduleCron = syncScheduleCron;
    if (enabled !== undefined) data.enabled = enabled;

    const result = await prisma.inventoryFeed.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Feed not found.' });
    res.json({ success: true });
  });

  // Delete a feed
  router.delete('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const result = await prisma.inventoryFeed.deleteMany({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Feed not found.' });
    res.json({ success: true });
  });

  // Trigger manual sync
  router.post('/:id/sync', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const feed = await prisma.inventoryFeed.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (!feed) return res.status(404).json({ error: 'Feed not found.' });

    const result = await feedSync.syncFeed(feed, prisma);
    res.json({ success: true, ...result });
  });

  // Sync with pre-fetched HTML (for sites with bot protection)
  router.post('/:id/sync-html', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const { html } = req.body;
    if (!html || typeof html !== 'string') {
      return res.status(400).json({ error: 'Missing html in request body.' });
    }

    const feed = await prisma.inventoryFeed.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (!feed) return res.status(404).json({ error: 'Feed not found.' });

    // Parse the pre-fetched HTML
    const { parseFeedHtml } = require('@autolander/shared/feed-parsers');
    const parsedVehicles = parseFeedHtml(html, feed.feedUrl, feed.feedType);

    // Now run the same sync logic as the normal sync endpoint
    // but with the pre-parsed vehicles instead of fetching
    const result = await feedSync.syncFeedWithVehicles(feed, parsedVehicles, prisma);
    res.json({ success: true, ...result });
  });

  // Get sync logs for a feed
  router.get('/:id/logs', async (req, res) => {
    const logs = await prisma.feedSyncLog.findMany({
      where: {
        feed: { id: req.params.id, orgId: req.orgId },
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    res.json({ logs });
  });

  return router;
};

function detectFeedType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('cargurus.com')) return 'CARGURUS';
  if (lower.includes('cars.com')) return 'CARSCOM';
  if (lower.includes('autotrader')) return 'AUTOTRADER';
  if (lower.endsWith('.xml')) return 'GENERIC_XML';
  return 'HTML_SCRAPE';
}
