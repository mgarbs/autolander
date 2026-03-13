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

  // Match a vehicle color to the closest Facebook Marketplace dropdown option
  router.post('/match-color', async (req, res) => {
    try {
      const { color, options } = req.body;
      if (!color || !Array.isArray(options) || options.length === 0) {
        return res.status(400).json({ error: 'color (string) and options (array) are required.' });
      }

      const Anthropic = require('@anthropic-ai/sdk');
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.json({ match: null });

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: `Vehicle color: "${color}"\nFacebook options: ${options.join(', ')}\n\nWhich single Facebook color option is the closest match? Reply with ONLY the color name, nothing else.`,
        }],
      });

      const match = response.content[0].text.trim();
      const validated = options.find(o => o.toLowerCase() === match.toLowerCase());
      res.json({ match: validated || null });
    } catch (error) {
      console.error('[ai] match-color error:', error.message);
      res.json({ match: null });
    }
  });

  // Generate a Facebook Marketplace listing description from vehicle data
  router.post('/generate-fb-description', async (req, res) => {
    try {
      const { vehicle } = req.body;
      if (!vehicle) return res.status(400).json({ error: 'vehicle object is required.' });

      const Anthropic = require('@anthropic-ai/sdk');
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.json({ description: null });

      const vehicleInfo = [
        vehicle.year && `Year: ${vehicle.year}`,
        vehicle.make && `Make: ${vehicle.make}`,
        vehicle.model && `Model: ${vehicle.model}`,
        vehicle.trim && `Trim: ${vehicle.trim}`,
        vehicle.price && `Price: $${Number(vehicle.price).toLocaleString()}`,
        vehicle.mileage && `Mileage: ${Number(vehicle.mileage).toLocaleString()} miles`,
        vehicle.color && `Color: ${vehicle.color}`,
        vehicle.bodyStyle && `Body Style: ${vehicle.bodyStyle}`,
        vehicle.transmission && `Transmission: ${vehicle.transmission}`,
        vehicle.fuelType && `Fuel Type: ${vehicle.fuelType}`,
        vehicle.vin && `VIN: ${vehicle.vin}`,
      ].filter(Boolean).join('\n');

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Write a Facebook Marketplace vehicle listing description that will SELL this car fast. Use proven techniques that work on FB Marketplace:

- Start with an attention-grabbing opening line (e.g. "Don't miss this one!" or "Priced to move!")
- Highlight the top 3-4 selling points (low miles, clean title, one owner, great condition, fuel economy, etc.)
- Use short punchy sentences - FB buyers scan quickly
- Include a sense of urgency (e.g. "Won't last at this price")
- End with a clear call to action (e.g. "Message me today for a test drive!")
- Add "Financing available. Trade-ins welcome." at the end
- Include the VIN if available
- Keep it 5-8 lines max. No hashtags. No emojis. No price (it goes in a separate field).

Vehicle details:
${vehicleInfo}`,
        }],
      });

      const desc = response.content[0].text.trim();
      res.json({ description: desc || null });
    } catch (error) {
      console.error('[ai] generate-fb-description error:', error.message);
      res.json({ description: null });
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
