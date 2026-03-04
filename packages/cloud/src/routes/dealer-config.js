'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');

module.exports = function createDealerConfigRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const configs = await prisma.dealerConfig.findMany({
      where: { orgId: req.orgId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ dealers: configs });
  });

  router.put('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const { url, platform, scrapeEnabled, schedule } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required.' });

    let detectedPlatform = platform || 'generic';
    const normalizedUrl = url.toLowerCase();
    if (normalizedUrl.includes('cargurus.com')) detectedPlatform = 'cargurus';
    else if (normalizedUrl.includes('dealeron.com')) detectedPlatform = 'dealeron';
    else if (normalizedUrl.includes('dealer.com')) detectedPlatform = 'dealercom';
    else if (normalizedUrl.includes('dealerinspire')) detectedPlatform = 'dealerinspire';

    const existing = await prisma.dealerConfig.findFirst({ where: { orgId: req.orgId } });

    let config;
    if (existing) {
      config = await prisma.dealerConfig.update({
        where: { id: existing.id },
        data: {
          url,
          platform: detectedPlatform,
          scrapeEnabled: scrapeEnabled !== false,
          schedule: schedule || undefined,
        },
      });
    } else {
      config = await prisma.dealerConfig.create({
        data: {
          orgId: req.orgId,
          url,
          platform: detectedPlatform,
          scrapeEnabled: scrapeEnabled !== false,
          schedule: schedule || { enabled: true, scrapeTime: '06:00' },
        },
      });
    }

    res.json({ success: true, dealer: config });
  });

  router.post('/sync', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const dispatcher = req.app.get('commandDispatcher');
    if (!dispatcher) {
      return res.json({ success: true, message: 'Sync queued (gateway not yet active).' });
    }

    try {
      const agentId = await dispatcher.pickAgent(req.orgId);
      if (!agentId) {
        return res.status(409).json({ error: 'No online agent available.' });
      }
      dispatcher.dispatch(req.orgId, agentId, 'check_inbox', {}).catch(() => {});
      res.json({ success: true, message: 'Sync dispatched to agent.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
