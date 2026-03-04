'use strict';

const express = require('express');

module.exports = function createAppointmentsRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const { status, from, to, agentId } = req.query;
    const where = { orgId: req.orgId };
    if (status) where.status = status;
    if (agentId) where.agentId = agentId;
    if (from || to) {
      where.scheduledTime = {};
      if (from) where.scheduledTime.gte = new Date(from);
      if (to) where.scheduledTime.lte = new Date(to);
    }

    const appointments = await prisma.appointment.findMany({
      where,
      include: {
        vehicle: { select: { year: true, make: true, model: true } },
        agent: { select: { displayName: true } },
      },
      orderBy: { scheduledTime: 'asc' },
    });

    res.json({ appointments });
  });

  router.post('/', async (req, res) => {
    const { buyerName, scheduledTime, vehicleId, agentId, notes } = req.body;
    if (!buyerName || !scheduledTime) {
      return res.status(400).json({ error: 'buyerName and scheduledTime are required.' });
    }

    const appointment = await prisma.appointment.create({
      data: {
        orgId: req.orgId,
        buyerName,
        scheduledTime: new Date(scheduledTime),
        vehicleId: vehicleId || null,
        agentId: agentId || req.user.id,
        notes,
      },
    });

    res.status(201).json(appointment);
  });

  router.put('/:id', async (req, res) => {
    const { status, scheduledTime, notes, googleEventId } = req.body;
    const data = {};
    if (status) data.status = status;
    if (scheduledTime) data.scheduledTime = new Date(scheduledTime);
    if (notes !== undefined) data.notes = notes;
    if (googleEventId) data.googleEventId = googleEventId;

    const result = await prisma.appointment.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'Appointment not found.' });
    res.json({ success: true });
  });

  router.delete('/:id', async (req, res) => {
    const result = await prisma.appointment.updateMany({
      where: { id: req.params.id, orgId: req.orgId },
      data: { status: 'CANCELLED' },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Appointment not found.' });
    res.json({ success: true });
  });

  return router;
};
