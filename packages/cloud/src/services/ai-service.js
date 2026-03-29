'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const LISTING_MODEL = 'claude-haiku-4-5-20251001';
const RESPONSE_MODEL = 'claude-sonnet-4-20250514';
const SCORING_MODEL = 'claude-opus-4-6';
const MAX_REQUESTS_PER_MINUTE = 10;
const ONE_MINUTE_MS = 60 * 1000;
const MAX_TOOL_ROUNDS = 6;

let anthropicClient = null;
const requestTimestampsByOrg = new Map();

function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function checkRateLimit(orgId) {
  const key = orgId || 'global';
  const now = Date.now();
  const timestamps = requestTimestampsByOrg.get(key) || [];
  const recent = timestamps.filter(ts => now - ts < ONE_MINUTE_MS);

  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    requestTimestampsByOrg.set(key, recent);
    return false;
  }

  recent.push(now);
  requestTimestampsByOrg.set(key, recent);
  return true;
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (_err2) {
      return null;
    }
  }
}

function extractTextContent(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter(block => block && block.type === 'tool_use')
    .map(block => ({ id: block.id, name: block.name, input: block.input }));
}

function buildListingFallback(vehicle) {
  const title = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}${vehicle.trim ? ' ' + vehicle.trim : ''}`.trim();
  const mileageText = vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString()} miles` : null;
  const priceText = vehicle.price ? `$${Number(vehicle.price).toLocaleString()}` : null;
  const conditionText = vehicle.condition ? `Condition: ${vehicle.condition}.` : '';
  const description = [
    `${title} for sale.`,
    mileageText ? `${mileageText}.` : '',
    priceText ? `Priced at ${priceText}.` : '',
    conditionText,
    'Contact us today for details or to schedule a test drive!',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  const highlights = [];
  if (mileageText) highlights.push(mileageText);
  if (priceText) highlights.push(`Price: ${priceText}`);
  if (vehicle.color) highlights.push(`Color: ${vehicle.color}`);
  if (vehicle.condition) highlights.push(`Condition: ${vehicle.condition}`);

  return { title, description, highlights };
}

function buildResponseFallback() {
  return {
    text: 'Thank you for your interest! I appreciate your message and will follow up shortly with more details.',
    toolCalls: [],
    fullMessages: [],
  };
}

// ─── Sales Agent Tools ───────────────────────────────────────────────

const SALES_TOOLS = [
  {
    name: 'get_vehicle_details',
    description: 'Get full details about the vehicle being discussed including features, description, photos, condition, and pricing. Call this when you need to answer specific questions about the vehicle or want to highlight selling points.',
    input_schema: {
      type: 'object',
      properties: {
        vehicleId: { type: 'string', description: 'The vehicle ID' },
      },
      required: ['vehicleId'],
    },
  },
  {
    name: 'get_available_slots',
    description: 'Get available appointment time slots for a given date. Use this to offer the buyer specific times to visit. Always offer 2-3 slots across 1-2 days.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment for the buyer to visit and see the vehicle. Call this only when the buyer has explicitly agreed to a specific time.',
    input_schema: {
      type: 'object',
      properties: {
        scheduledTime: { type: 'string', description: 'ISO 8601 datetime for the appointment' },
        buyerName: { type: 'string' },
        buyerEmail: { type: 'string', description: 'Buyer email if already known (optional)' },
        buyerPhone: { type: 'string', description: 'Buyer phone (optional)' },
        notes: { type: 'string', description: 'Any notes about what the buyer wants to see/do' },
      },
      required: ['scheduledTime', 'buyerName'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment. Use this when the buyer wants to reschedule - cancel the old one first, then book the new time with book_appointment.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the appointment is being cancelled (e.g. "buyer requested reschedule to 3pm")' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'update_buyer_info',
    description: 'Save buyer information collected during conversation. Call this as soon as the buyer provides their email, phone number, full name, financing preference (cash/financing/lease), or trade-in vehicle details.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        fullName: { type: 'string' },
        financing: { type: 'string', description: 'Financing preference: "financing", "cash", "lease", or other' },
        tradeIn: { type: 'string', description: 'Trade-in vehicle description if the buyer mentions one' },
      },
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Flag this conversation for human salesperson takeover. Use when: angry customer, legal issues, complex negotiation, unusual requests, or anything you\'re not confident handling.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief explanation of why escalation is needed' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How urgently a human needs to respond' },
      },
      required: ['reason'],
    },
  },
];

// ─── System Prompt Builder ───────────────────────────────────────────

function buildSalesSystemPrompt(conversation, options) {
  const dealerName = options.dealerName || 'our dealership';
  const v = conversation.vehicle || {};
  const vehicleJson = JSON.stringify({
    id: v.id || conversation.vehicleId,
    year: v.year, make: v.make, model: v.model, trim: v.trim,
    price: v.price, mileage: v.mileage, color: v.color,
    condition: v.condition, bodyStyle: v.bodyStyle,
    transmission: v.transmission, fuelType: v.fuelType,
  });

  const missingInfo = [];
  if (!conversation.buyerEmail) missingInfo.push('email');
  if (!conversation.buyerPhone) missingInfo.push('phone');
  if (missingInfo.length === 0) missingInfo.push('none — you have their contact info');

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
  const currentTime = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrowDay = tomorrowDate.toLocaleDateString('en-US', { weekday: 'long' });
  const tomorrowISO = tomorrowDate.toISOString().split('T')[0];

  return [
    `You are a top-performing automotive sales closer for ${dealerName}. You have an ALWAYS BE CLOSING mindset. Every message moves toward getting the buyer in the door. You never let a conversation die. You never let a lead go cold. You are warm, confident, and relentless — like the best salesperson the buyer has ever talked to.`,
    '',
    'CLOSER MINDSET (internalize these — this is who you are):',
    '- You OWN this conversation. The buyer messaged YOU. They want this car. Your job is to make it easy for them to come see it.',
    '- Every response ends with a question or call to action. NEVER leave the buyer with nothing to respond to.',
    '- If the buyer suggests ANY time, you say YES and book it. Their time is always the right time.',
    '- If the buyer rejects your times, ask "What time works best for you?" and accept whatever they say.',
    '- If the buyer hesitates on price, pivot to value and the in-person experience. Never defend the price.',
    '- If the buyer asks a question, answer it in ONE sentence then pivot back to the visit.',
    '- You sound like a real person texting a friend. Short, casual, confident. Never corporate. Never robotic.',
    '- One exclamation mark per message MAX. Contractions always. No bullet points. No lists.',
    '',
    'GOAL HIERARCHY (this order, always):',
    '1. BOOK THE APPOINTMENT — offer today\'s slots first. Accept ANY time the buyer proposes. Use get_available_slots then book_appointment.',
    '2. GET CONTACT INFO — after booking: email first, then phone. One per message. Use update_buyer_info immediately.',
    '3. BUILD EXCITEMENT — after info collected, hype the vehicle: "You\'re gonna love this one in person — the [feature] is even better than the photos."',
    '4. NEVER LET THE CONVERSATION DIE — if there\'s nothing left to do, ask about their needs: financing, trade-in, what features matter.',
    '',
    'HANDLING OBJECTIONS (always pivot, never surrender):',
    '- "Those times don\'t work" → "No problem — what time works best for you?" Then ACCEPT and BOOK whatever they say.',
    '- "I\'m not sure about the price" → "Totally understand — come see it in person and I think you\'ll see the value. When works for you?"',
    '- "I need to think about it" → "Of course — no pressure at all. I can hold a time slot for you just in case. Want me to pencil you in for [time] and you can always cancel?"',
    '- "Is the price negotiable?" → "Everything\'s negotiable once you\'re here — let\'s get you in to see it first. When are you free?"',
    '- "I\'m just looking" → "That\'s the best way to start! Come check it out — no commitment. I have [time] and [time] open today."',
    '- "I found it cheaper elsewhere" → "Appreciate you telling me that — let me see what we can do. Worth coming in to compare in person. When works?"',
    '- "Is it still available?" → "Yes! And it\'s been getting a lot of interest. Want to come see it today? I have [times]."',
    '- ANY question about the car → answer honestly in one sentence, then: "Want to come see it in person? I have [times]."',
    '',
    'CRITICAL RULES (ABSOLUTE — VIOLATING THESE IS A FAILURE):',
    '- When the buyer says ANY specific time (e.g. "4pm", "how about 2", "Thursday at noon"), IMMEDIATELY call book_appointment. Do NOT re-ask. Do NOT offer alternatives. BOOK IT.',
    '- After booking, ask for email. When they give it, call update_buyer_info IMMEDIATELY.',
    '- NEVER repeat a previous response. Read the conversation history.',
    '- NEVER re-ask a question the buyer already answered.',
    '- NEVER end a message without a question or call to action. "Let me know" is BANNED. Instead: "When works for you?" or "Want me to have it ready for [time]?"',
    '- ALWAYS respond with exactly ONE message. No bullet points. No multiple paragraphs. One flowing text.',
    '- ALWAYS advance the conversation forward. Never go backwards.',
    '- CONTACT INFO: When the buyer provides email or phone, call update_buyer_info IMMEDIATELY before writing your response.',
    '- DEAL INFO: When the buyer mentions cash/financing/lease or a trade-in, call update_buyer_info immediately.',
    '- ACKNOWLEDGE contact info: "Got your email!" or "Thanks for the number!" confirms you captured it.',
    '',
    'RESPONSE RULES:',
    '- HARD LIMIT: 280 characters max. Aim for under 200. Messages over 280 get cut off.',
    '- Sound like a real person texting, not a corporate bot.',
    '- Use the buyer\'s name when you have it.',
    '- When highlighting the vehicle, pick 2-3 specific things (color, mileage, features) — not generic praise.',
    '- Subtle urgency when natural: "This one\'s been getting a lot of interest" or "Just had someone else ask about it." Never fake.',
    '- After booking, build anticipation: "You\'re gonna love it in person — the [specific feature] is even better than the photos."',
    '- Never end with "let me know" — always assume the next step: "I\'ll have it pulled up front for you" or "I\'ll make sure it\'s detailed and ready."',
    '- If the conversation involves: angry customer, legal threats, profanity → call escalate_to_human.',
    '',
    'CONVERSATION STATE:',
    `- Current state: ${conversation.state || 'NEW'}`,
    '- NEW: Excitement about the car + offer 2-3 appointment times for today. Call get_vehicle_details.',
    '- ENGAGED: Push toward a specific time. If they hesitate, ask what time works for THEM.',
    '- APPOINTMENT_SET: Appointment booked. Collect missing info (email → phone → financing/trade-in). Build excitement about the visit. If reschedule needed: cancel_appointment then book_appointment with new time.',
    '',
    'INFO COLLECTION (one thing per message, in this order):',
    '1. Book appointment → "Let me send you a confirmation — what\'s your email?"',
    '2. Email captured → "And best number to reach you day-of?"',
    '3. Phone captured → "Are you looking at financing or paying cash? Any trade-in?"',
    '4. All info → "Perfect, I\'ll have everything ready for you. See you at [time]!"',
    'System auto-sends confirmation email + calendar invite when email + appointment exist.',
    '',
    'VEHICLE CONTEXT:',
    vehicleJson,
    '',
    'BUYER CONTEXT:',
    `- Name: ${conversation.buyerName || 'Unknown'}`,
    `- Email: ${conversation.buyerEmail || 'not yet collected'}`,
    `- Phone: ${conversation.buyerPhone || 'not yet collected'}`,
    `- Financing: ${conversation.financingType || 'not yet asked'}`,
    `- Trade-in: ${conversation.tradeInDescription || 'not yet asked'}`,
    `- Info still needed: ${missingInfo.join(', ')}`,
    '',
    'WHAT HAS ALREADY HAPPENED (DO NOT REPEAT):',
    `- Appointment: ${conversation.state === 'APPOINTMENT_SET' ? 'BOOKED. Do NOT rebook or offer new times unless buyer asks to reschedule.' : 'Not yet — guide toward booking.'}`,
    `- Email: ${conversation.buyerEmail ? 'CAPTURED (' + conversation.buyerEmail + '). Do NOT ask again.' : 'Not yet — ask after booking.'}`,
    `- Phone: ${conversation.buyerPhone ? 'CAPTURED (' + conversation.buyerPhone + '). Do NOT ask again.' : 'Not yet — ask after email.'}`,
    `- Confirmation: ${conversation.state === 'APPOINTMENT_SET' && conversation.buyerEmail ? 'ALREADY SENT. Do NOT offer again.' : 'Not yet sent.'}`,
    '',
    'ANTI-REPETITION: Read the last 3 dealer messages. If your reply says the same thing, write something different or shorter.',
    '',
    `RIGHT NOW: ${dayOfWeek}, ${today} at ${currentTime}`,
    `TOMORROW: ${tomorrowDay}, ${tomorrowISO}`,
    'NEVER book times in the past. If today is mostly gone, offer tomorrow.',
    'Today is ' + dayOfWeek + ', tomorrow is ' + tomorrowDay + '. Use correct day names.',
    '',
    'EXAMPLE FLOWS:',
    '',
    'FLOW 1 — Standard close:',
    'Buyer: "Is this still available?"',
    'You: [get_vehicle_details + get_available_slots] "Hey! Yes, this [year] [model] is still here — [highlight]. Want to come see it? I have 10am, 1pm, or 3:30 today."',
    'Buyer: "2:30 works better"',
    'You: [book_appointment at 2:30] "Done! 2:30 it is. Let me send you a confirmation — what\'s your email?"',
    '',
    'FLOW 2 — Buyer rejects times:',
    'Buyer: "None of those work"',
    'You: "No problem — what time works best for you?"',
    'Buyer: "Saturday at 4"',
    'You: [book_appointment Saturday 4pm] "You\'re all set for Saturday at 4. What\'s your email so I can send confirmation?"',
    '',
    'FLOW 3 — Price objection:',
    'Buyer: "That\'s too expensive"',
    'You: "Totally get it — come see it in person and I think you\'ll see the value. Plus everything\'s negotiable once you\'re here. When works for you?"',
    '',
    'FLOW 4 — Just browsing:',
    'Buyer: "Just looking for now"',
    'You: "No pressure at all! Want me to pencil you in for a quick look? No commitment — I have [times] open today."',
    '',
    'BANNED PHRASES: "let me know", "feel free to", "don\'t hesitate", "at your convenience", "when you get a chance"',
    'ALWAYS USE INSTEAD: direct questions that assume the next step is happening.',
  ].join('\n');
}

// ─── Tool Execution ──────────────────────────────────────────────────

async function executeToolCall(toolName, toolInput, context) {
  console.log(`[auto-reply] TOOL CALL: ${toolName}(${JSON.stringify(toolInput)})`);
  const { prisma, orgSettings, conversation, orgId } = context;

  switch (toolName) {
    case 'get_vehicle_details': {
      const vehicleId = toolInput.vehicleId || conversation.vehicleId;
      if (!vehicleId) return JSON.stringify({ error: 'No vehicle associated with this conversation' });
      const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, orgId } });
      if (!vehicle) return JSON.stringify({ error: 'Vehicle not found' });
      return JSON.stringify({
        year: vehicle.year, make: vehicle.make, model: vehicle.model,
        trim: vehicle.trim, price: vehicle.price, mileage: vehicle.mileage,
        color: vehicle.color, bodyStyle: vehicle.bodyStyle,
        transmission: vehicle.transmission, fuelType: vehicle.fuelType,
        condition: vehicle.condition, description: vehicle.description,
        photoCount: (vehicle.photos || []).length,
      });
    }

    case 'get_available_slots': {
      // Generate business-hours slots (9AM-5PM, 30-min intervals)
      const requestedDate = toolInput.date ? new Date(toolInput.date) : new Date();
      const now = new Date();
      const slots = [];
      for (let hour = 9; hour < 17; hour++) {
        for (const min of [0, 30]) {
          const slotTime = new Date(requestedDate);
          slotTime.setHours(hour, min, 0, 0);
          if (slotTime > now) {
            slots.push({
              start: slotTime.toISOString(),
              end: new Date(slotTime.getTime() + 30 * 60000).toISOString(),
              label: slotTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
            });
          }
        }
      }
      if (slots.length === 0) {
        return JSON.stringify({ available: false, message: 'No open slots remaining on this date. Try another day.' });
      }
      return JSON.stringify({ available: true, slots: slots.slice(0, 6) });
    }

    case 'book_appointment': {
      // Reject appointments in the past
      const requestedTime = new Date(toolInput.scheduledTime);
      if (requestedTime < new Date()) {
        return JSON.stringify({ error: 'Cannot book an appointment in the past. Please offer a future time slot.' });
      }

      const oneHourBefore = new Date(requestedTime.getTime() - 60 * 60 * 1000);
      const oneHourAfter = new Date(requestedTime.getTime() + 60 * 60 * 1000);
      const existingAppt = await prisma.appointment.findFirst({
        where: {
          orgId,
          vehicleId: conversation.vehicleId,
          buyerName: { equals: toolInput.buyerName, mode: 'insensitive' },
          scheduledTime: { gte: oneHourBefore, lte: oneHourAfter },
          status: { not: 'CANCELLED' },
        },
      });

      if (existingAppt) {
        console.log(`[auto-reply] Appointment already exists: ${existingAppt.id}`);
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { state: 'APPOINTMENT_SET' },
        });
        return JSON.stringify({
          success: true,
          appointmentId: existingAppt.id,
          alreadyExisted: true,
          scheduledTime: existingAppt.scheduledTime,
        });
      }

      const appt = await prisma.appointment.create({
        data: {
          orgId,
          agentId: conversation.agentId,
          vehicleId: conversation.vehicleId,
          buyerName: toolInput.buyerName,
          scheduledTime: requestedTime,
          status: 'SCHEDULED',
          notes: toolInput.notes || null,
        },
      });

      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: 'APPOINTMENT_SET' },
      });

      return JSON.stringify({
        success: true,
        appointmentId: appt.id,
        scheduledTime: toolInput.scheduledTime,
      });
    }

    case 'cancel_appointment': {
      const existing = await prisma.appointment.findFirst({
        where: {
          orgId,
          vehicleId: conversation.vehicleId,
          buyerName: conversation.buyerName,
          status: 'SCHEDULED',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!existing) {
        const anyExisting = await prisma.appointment.findFirst({
          where: {
            orgId,
            buyerName: conversation.buyerName,
            status: 'SCHEDULED',
          },
          orderBy: { createdAt: 'desc' },
        });
        if (!anyExisting) {
          return JSON.stringify({ cancelled: false, reason: 'No active appointment found' });
        }
        await prisma.appointment.update({
          where: { id: anyExisting.id },
          data: {
            status: 'CANCELLED',
            notes: (anyExisting.notes || '') + ' | Cancelled: ' + (toolInput.reason || ''),
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { state: 'ENGAGED' },
        });
        console.log(`[auto-reply] Cancelled appointment ${anyExisting.id}: ${toolInput.reason}`);
        return JSON.stringify({ cancelled: true, appointmentId: anyExisting.id, previousTime: anyExisting.scheduledTime });
      }
      await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          notes: (existing.notes || '') + ' | Cancelled: ' + (toolInput.reason || ''),
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: 'ENGAGED' },
      });
      console.log(`[auto-reply] Cancelled appointment ${existing.id}: ${toolInput.reason}`);
      return JSON.stringify({ cancelled: true, appointmentId: existing.id, previousTime: existing.scheduledTime });
    }

    case 'update_buyer_info': {
      const updateData = {};
      if (toolInput.fullName) updateData.buyerName = toolInput.fullName;
      if (toolInput.email) updateData.buyerEmail = toolInput.email;
      if (toolInput.financing) updateData.financingType = toolInput.financing;
      if (toolInput.tradeIn) updateData.tradeInDescription = toolInput.tradeIn;
      if (toolInput.phone) updateData.buyerPhone = toolInput.phone;
      if (Object.keys(updateData).length > 0) {
        await prisma.conversation.update({ where: { id: conversation.id }, data: updateData });
      }

      return JSON.stringify({ updated: true, fields: Object.keys(updateData) });
    }

    case 'escalate_to_human': {
      return JSON.stringify({ escalated: true, reason: toolInput.reason });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  async generateListing(vehicle, options = {}) {
    const fallback = buildListingFallback(vehicle || {});
    const client = getAnthropicClient();
    const orgId = options.orgId || (vehicle && vehicle.orgId);
    if (!client || !checkRateLimit(orgId)) return fallback;

    const tone = options.tone || 'professional and friendly';
    const language = options.language || 'English';
    const maxLength = Number.isFinite(options.maxLength) ? options.maxLength : 1200;

    const prompt = [
      'Create a Facebook Marketplace vehicle listing.',
      `Tone: ${tone}.`,
      `Language: ${language}.`,
      `Max description length: ${maxLength} characters.`,
      'Return strict JSON only with this shape:',
      '{"title":"string","description":"string","highlights":["string"]}',
      '',
      'Vehicle data:',
      JSON.stringify({
        year: vehicle && vehicle.year,
        make: vehicle && vehicle.make,
        model: vehicle && vehicle.model,
        trim: vehicle && vehicle.trim,
        mileage: vehicle && vehicle.mileage,
        price: vehicle && vehicle.price,
        color: vehicle && vehicle.color,
        vin: vehicle && vehicle.vin,
        features: Array.isArray(vehicle && vehicle.features) ? vehicle.features : [],
        condition: vehicle && vehicle.condition,
        description: vehicle && vehicle.description,
      }),
      '',
      'Rules:',
      '- Keep the title concise and compelling.',
      '- Description should be clear, honest, and buyer-focused.',
      '- Highlights should be a short array of key selling points.',
      '- Do not include markdown or extra keys.',
    ].join('\n');

    try {
      const response = await client.messages.create({
        model: LISTING_MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = extractTextContent(response);
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== 'object') return fallback;

      const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : fallback.title;
      const description =
        typeof parsed.description === 'string' && parsed.description.trim()
          ? parsed.description.trim().slice(0, maxLength)
          : fallback.description;
      const highlights = Array.isArray(parsed.highlights)
        ? parsed.highlights.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 8)
        : fallback.highlights;

      return { title, description, highlights };
    } catch (_err) {
      return fallback;
    }
  },

  async generateResponse(conversation, messages, options = {}) {
    const fallback = buildResponseFallback();
    const client = getAnthropicClient();
    const orgId = options.orgId || (conversation && conversation.orgId);
    if (!client || !checkRateLimit(orgId)) return fallback;

    const systemPrompt = buildSalesSystemPrompt(conversation, options);

    const history = (Array.isArray(messages) ? messages : []).map(message => ({
      role: message && message.role === 'assistant' ? 'assistant' : 'user',
      content: message && message.content ? message.content : '',
    }));

    if (history.length === 0) {
      history.push({ role: 'user', content: 'Is this still available?' });
    }

    try {
      const response = await client.messages.create({
        model: RESPONSE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: SALES_TOOLS,
        messages: history,
      });

      const text = extractTextContent(response);
      const toolCalls = extractToolCalls(response);
      const fullMessages = [...history, { role: 'assistant', content: response.content }];

      return { text, toolCalls, fullMessages };
    } catch (err) {
      console.error('[ai-service] generateResponse error:', err.message);
      return fallback;
    }
  },

  async continueWithToolResults(conversation, _originalMessages, fullMessages, toolResults, options = {}) {
    const fallback = buildResponseFallback();
    const client = getAnthropicClient();
    const orgId = options.orgId || (conversation && conversation.orgId);
    if (!client || !checkRateLimit(orgId)) return fallback;

    const systemPrompt = buildSalesSystemPrompt(conversation, options);

    const toolResultMessages = toolResults.map(tr => ({
      type: 'tool_result',
      tool_use_id: tr.tool_use_id,
      content: tr.content,
    }));

    const continuedMessages = [...fullMessages, { role: 'user', content: toolResultMessages }];

    try {
      const response = await client.messages.create({
        model: RESPONSE_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: SALES_TOOLS,
        messages: continuedMessages,
      });

      const text = extractTextContent(response);
      const toolCalls = extractToolCalls(response);
      const updatedMessages = [...continuedMessages, { role: 'assistant', content: response.content }];

      return { text, toolCalls, fullMessages: updatedMessages };
    } catch (err) {
      console.error('[ai-service] continueWithToolResults error:', err.message);
      return fallback;
    }
  },

  async executeToolCall(toolName, toolInput, context) {
    try {
      return await executeToolCall(toolName, toolInput, context);
    } catch (err) {
      console.error(`[ai-service] Tool ${toolName} failed:`, err.message);
      return JSON.stringify({ error: `Tool execution failed: ${err.message}` });
    }
  },

  async scoreLeadAI(conversation, messages, options = {}) {
    const client = getAnthropicClient();
    const orgId = options.orgId || (conversation && conversation.orgId);
    if (!client || !checkRateLimit(orgId)) {
      return { score: 20, sentiment: 'cold', category: 'unknown', summary: 'AI scoring unavailable' };
    }

    const vehicleInfo = conversation.vehicle
      ? `${conversation.vehicle.year || ''} ${conversation.vehicle.make || ''} ${conversation.vehicle.model || ''}`.trim()
      : 'Unknown vehicle';

    const messageHistory = (Array.isArray(messages) ? messages : [])
      .slice(-15)
      .map(m => `${m.direction === 'INBOUND' ? 'BUYER' : 'DEALER'}: ${m.text}`)
      .join('\n');

    const prompt = [
      'You are an expert automotive sales analyst. Analyze this Facebook Marketplace conversation between a car buyer and dealer.',
      '',
      `Vehicle: ${vehicleInfo}`,
      `Buyer: ${conversation.buyerName || 'Unknown'}`,
      `Current state: ${conversation.state || 'NEW'}`,
      '',
      'Message history:',
      messageHistory || '(No messages yet)',
      '',
      'Score this lead from 0-100 based on:',
      '- How likely is this buyer to purchase? (buying signals, urgency, financial readiness)',
      '- What is the buyer\'s sentiment? (positive, negative, neutral, frustrated)',
      '- What stage of the buying journey are they in?',
      '- Are there any red flags? (tire kickers, lowballers, no-shows)',
      '',
      'Return strict JSON only:',
      '{"score": number 0-100, "sentiment": "hot"|"warm"|"cold"|"dead", "category": string, "summary": string, "buyerIntent": string, "recommendedAction": string}',
      '',
      'Categories: "ready_to_buy", "serious_inquiry", "price_shopping", "just_browsing", "tire_kicker", "lost_cause"',
      'Keep summary to 1-2 sentences. recommendedAction should be a specific next step for the salesperson.',
    ].join('\n');

    try {
      const response = await client.messages.create({
        model: SCORING_MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = extractTextContent(response);
      const parsed = safeJsonParse(text);
      if (!parsed || typeof parsed !== 'object') {
        return { score: 20, sentiment: 'cold', category: 'unknown', summary: 'Failed to parse AI response' };
      }

      const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.score))) : 20;
      const validSentiments = ['hot', 'warm', 'cold', 'dead'];
      const sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : 'cold';

      return {
        score,
        sentiment,
        category: parsed.category || 'unknown',
        summary: parsed.summary || '',
        buyerIntent: parsed.buyerIntent || '',
        recommendedAction: parsed.recommendedAction || '',
      };
    } catch (_err) {
      return { score: 20, sentiment: 'cold', category: 'unknown', summary: 'AI scoring failed' };
    }
  },
};
