'use strict';

const express = require('express');
const aiService = require('../services/ai-service');

module.exports = function createAiRouter(prisma) {
  const router = express.Router();

  // Generate a listing for a vehicle
  router.post('/generate-listing', async (req, res) => {
    try {
      const { vehicleId } = req.body;
      if (!vehicleId) return res.status(400).json({ error: 'vehicleId is required.' });

      const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, orgId: req.orgId },
      });
      if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

      const { title, description, highlights } = await aiService.generateListing(vehicle, req.body.options || {});

      res.json({ title, description, highlights });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Generate an AI response for a conversation
  router.post('/generate-response', async (req, res) => {
    try {
      const { conversationId, options } = req.body;
      if (!conversationId) return res.status(400).json({ error: 'conversationId is required.' });

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, orgId: req.orgId },
        include: { messages: true },
      });
      if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });

      const { text, handoff, confidence } = await aiService.generateResponse(
        conversation,
        conversation.messages,
        options || {}
      );

      res.json({ text, handoff, confidence });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
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
