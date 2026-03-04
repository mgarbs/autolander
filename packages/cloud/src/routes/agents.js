'use strict';

const express = require('express');
const { requireRole } = require('../middleware/auth');

module.exports = function createAgentsRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const agents = await prisma.user.findMany({
      where: { orgId: req.orgId, role: 'AGENT' },
      select: {
        id: true, username: true, displayName: true, createdAt: true,
        agentConnections: {
          select: { status: true, fbSessionValid: true, fbSessionExpiry: true, lastHeartbeat: true },
        },
      },
    });
    res.json({ agents });
  });

  router.get('/:id/status', async (req, res) => {
    const connection = await prisma.agentConnection.findFirst({
      where: { userId: req.params.id, orgId: req.orgId },
    });
    res.json(connection || { status: 'OFFLINE', fbSessionValid: false });
  });

  router.post('/:id/command', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
    const dispatcher = req.app.get('commandDispatcher');
    if (!dispatcher) {
      return res.status(501).json({ error: 'Command dispatch not available.' });
    }

    const { command, payload, timeout } = req.body;
    if (!command) {
      return res.status(400).json({ error: 'command is required.' });
    }

    try {
      const result = await dispatcher.dispatch(req.orgId, req.params.id, command, payload || {}, { timeout });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
    const result = await prisma.user.deleteMany({
      where: { id: req.params.id, orgId: req.orgId, role: 'AGENT' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Agent not found.' });
    res.json({ success: true });
  });

  return router;
};
