'use strict';

const express = require('express');

module.exports = function createAiRouter(prisma) {
  const router = express.Router();

  // Generate a listing for a vehicle
  router.post('/generate-listing', async (req, res) => {
    const { vehicleId } = req.body;
    if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required.' });

    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, orgId: req.orgId },
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

    // TODO: Phase 3 — call ai-service.js
    const title = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ' ' + vehicle.trim : ''}`;
    const description = `Beautiful ${vehicle.year} ${vehicle.make} ${vehicle.model}. ${vehicle.mileage ? vehicle.mileage.toLocaleString() + ' miles.' : ''} ${vehicle.condition ? 'Condition: ' + vehicle.condition + '.' : ''} Contact us for details!`;

    res.json({ title, description });
  });

  // Generate an AI response for a conversation
  router.post('/generate-response', async (req, res) => {
    const { conversationId, buyerMessage } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

    // TODO: Phase 3 — call ai-service.js
    res.json({
      response: 'Thank you for your interest! Let me get back to you with more details.',
      handoff: false,
    });
  });

  // Score a lead
  router.post('/score-lead', async (req, res) => {
    const { conversationId } = req.body;
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, orgId: req.orgId },
      include: { messages: true },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

    // Use shared lead scorer
    const { scoreLead } = require('@autolander/shared/lead-scorer');
    const convState = {
      state: conversation.state.toLowerCase(),
      lastIntent: conversation.messages[conversation.messages.length - 1]?.intent || 'unknown',
      messageCount: conversation.messages.length,
      lastMessageAt: conversation.lastMessageAt,
      vehicleSummary: 'Vehicle',
    };
    const messages = conversation.messages.map(m => ({
      direction: m.direction === 'INBOUND' ? 'incoming' : 'outgoing',
      text: m.text,
      intent: m.intent,
      timestamp: m.createdAt,
    }));

    const score = scoreLead(convState, messages, conversation.sentimentScore);

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { leadScore: score.sentimentScore, sentimentScore: score.sentimentScore },
    });

    res.json({ score });
  });

  return router;
};
