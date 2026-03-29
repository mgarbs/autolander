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

      const fbColors = ['Black', 'Blue', 'Brown', 'Gold', 'Green', 'Grey', 'Pink', 'Purple', 'Red', 'Silver', 'Orange', 'White', 'Yellow', 'Charcoal', 'Off white', 'Tan', 'Beige', 'Burgundy', 'Turquoise'];

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `You have TWO tasks. Respond in this EXACT JSON format and nothing else:
{"description": "your listing text here", "exteriorColor": "closest FB color", "interiorColor": "closest FB color"}

TASK 1 — Write a Facebook Marketplace vehicle listing description:
- Attention-grabbing opening (e.g. "Don't miss this one!")
- Top 3-4 selling points (low miles, clean title, condition, fuel economy)
- Short punchy sentences — FB buyers scan quickly
- Urgency (e.g. "Won't last at this price")
- Call to action (e.g. "Message me today for a test drive!")
- Add "Financing available. Trade-ins welcome."
- Include VIN if available
- 5-8 lines max. No hashtags. No emojis. No price. No markdown. Plain text only.

TASK 2 — Match the vehicle's colors to Facebook Marketplace dropdown options.
Facebook only allows these colors: ${fbColors.join(', ')}
- For exteriorColor: map "${vehicle.color || 'unknown'}" to the closest FB color from the list above.
- For interiorColor: based on the vehicle (${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim || ''}), pick the most likely interior color. Most cars have Black interiors, but luxury/light-colored cars often have Grey, Beige, or Tan.

Vehicle details:
${vehicleInfo}

RESPOND WITH ONLY THE JSON OBJECT. No explanation.`,
        }],
      });

      const rawText = response.content[0].text.trim();
      let parsed = null;
      try {
        const jsonStart = rawText.indexOf('{');
        const jsonEnd = rawText.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
          parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
        }
      } catch {}

      const desc = parsed?.description || rawText.replace(/^#+\s*/gm, '').replace(/^\{.*\}$/s, '').trim();
      const extColor = fbColors.includes(parsed?.exteriorColor) ? parsed.exteriorColor : null;
      const intColor = fbColors.includes(parsed?.interiorColor) ? parsed.interiorColor : null;

      res.json({
        description: desc || null,
        exteriorColor: extColor,
        interiorColor: intColor,
      });
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
