'use strict';

const express = require('express');

module.exports = function createConversationsRouter(prisma) {
  const router = express.Router();

  router.get('/pipeline', async (req, res) => {
    const orgId = req.orgId;
    const [hot, warm, cold, dead] = await Promise.all([
      prisma.conversation.count({ where: { orgId, leadScore: { gte: 70 } } }),
      prisma.conversation.count({ where: { orgId, leadScore: { gte: 45, lt: 70 } } }),
      prisma.conversation.count({ where: { orgId, leadScore: { gte: 20, lt: 45 } } }),
      prisma.conversation.count({ where: { orgId, leadScore: { lt: 20 } } }),
    ]);
    res.json({ hot, warm, cold, dead });
  });

  router.get('/', async (req, res) => {
    const { sentiment, state, agentId, limit = '50', offset = '0' } = req.query;
    const where = { orgId: req.orgId };

    if (sentiment === 'hot') where.leadScore = { gte: 70 };
    else if (sentiment === 'warm') where.leadScore = { gte: 45, lt: 70 };
    else if (sentiment === 'cold') where.leadScore = { gte: 20, lt: 45 };
    else if (sentiment === 'dead') where.leadScore = { lt: 20 };

    if (state) where.state = state;
    if (agentId) where.agentId = agentId;

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        vehicle: { select: { year: true, make: true, model: true, vin: true } },
        agent: { select: { displayName: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset),
    });

    res.json(conversations);
  });

  router.post('/', async (req, res) => {
    const { buyerName, buyerId, state, leadScore, vehicleId, agentId } = req.body;
    if (!buyerName) return res.status(400).json({ error: 'buyerName is required.' });

    const conversation = await prisma.conversation.create({
      data: {
        orgId: req.orgId,
        buyerName,
        buyerId: buyerId || null,
        state: state || 'NEW',
        leadScore: leadScore !== undefined ? parseInt(leadScore) : 20,
        vehicleId: vehicleId || null,
        agentId: agentId || req.user.sub,
        lastMessageAt: new Date(),
      },
    });
    res.status(201).json(conversation);
  });

  router.get('/:id', async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        vehicle: true,
        agent: { select: { displayName: true, username: true } },
      },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(conversation);
  });

  router.put('/:id', async (req, res) => {
    const { state, leadScore, agentId } = req.body;
    const data = {};
    if (state) data.state = state;
    if (leadScore !== undefined) data.leadScore = parseInt(leadScore);
    if (agentId !== undefined) data.agentId = agentId;

    const result = await prisma.conversation.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ success: true });
  });

  router.post('/:id/messages', async (req, res) => {
    const { direction, text, intent } = req.body;
    if (!direction || !text) {
      return res.status(400).json({ error: 'direction and text are required.' });
    }

    const conv = await prisma.conversation.findFirst({
      where: { id: req.params.id, orgId: req.orgId },
    });
    if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

    const message = await prisma.message.create({
      data: { conversationId: conv.id, direction, text, intent },
    });

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() },
    });

    res.status(201).json(message);
  });

  return router;
};
