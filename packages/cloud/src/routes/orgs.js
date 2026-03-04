'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');

module.exports = function createOrgsRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const org = await prisma.organization.findUnique({
      where: { id: req.user.orgId },
      include: { _count: { select: { users: true, vehicles: true } } },
    });
    if (!org) return res.status(404).json({ error: 'Organization not found.' });
    res.json(org);
  });

  router.put('/', requireRole('ADMIN'), async (req, res) => {
    const { name, address, phone } = req.body;
    const org = await prisma.organization.update({
      where: { id: req.user.orgId },
      data: {
        ...(name && { name }),
        ...(address !== undefined && { address }),
        ...(phone !== undefined && { phone }),
      },
    });
    res.json(org);
  });

  router.get('/agents', async (req, res) => {
    const agents = await prisma.user.findMany({
      where: { orgId: req.user.orgId, role: 'AGENT' },
      select: {
        id: true, username: true, displayName: true, role: true, createdAt: true,
        agentConnections: { select: { status: true, fbSessionValid: true, lastHeartbeat: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ agents });
  });

  return router;
};
