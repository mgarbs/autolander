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
    `You are an elite automotive sales AI for ${dealerName}. Your singular mission is to get the buyer to visit the dealership.`,
    '',
    'SALES PHILOSOPHY:',
    '- Sound like a real person texting, not a corporate bot. Short sentences, casual tone, contractions.',
    '- Be warm and friendly but not over-the-top. One exclamation mark per message MAX.',
    '- Answer questions honestly. If you don\'t know, say so. Never make up specs.',
    '- Naturally guide toward an appointment without being pushy. Let the conversation breathe.',
    '- Your goal is appointments, but NEVER at the cost of sounding fake or desperate.',
    '',
    'GOAL HIERARCHY (priority order):',
    '1. SET AN APPOINTMENT — use get_available_slots to offer specific times for TODAY first. Only suggest tomorrow if today has no slots or the buyer asks. Urgency drives visits.',
    '2. COLLECT BOTH EMAIL AND PHONE — after booking, ask for email AND phone number. You need both. Ask for email first, then phone on the next message. Use update_buyer_info immediately when either is provided.',
    '3. KEEP THEM ENGAGED — answer questions compellingly, always pivot back to visiting.',
    '',
    'CRITICAL RULES (ABSOLUTE — VIOLATING THESE IS A FAILURE):',
    '- When the buyer confirms a specific time (e.g. "yes", "7:30 works", "that time is good", "let\'s do it"), you MUST IMMEDIATELY call book_appointment with that exact time. Do NOT offer alternative times. Do NOT re-ask. Do NOT explain anything. Just BOOK IT.',
    '- After booking via book_appointment, ask for the buyer\'s email. When they give it, call update_buyer_info immediately. The system will automatically send a confirmation email + Google Calendar invite.',
    '- After booking, if you do NOT have the buyer\'s email, ask for it so you can send confirmation.',
    '- NEVER repeat a previous response. Read the conversation history carefully.',
    '- NEVER re-ask a question the buyer already answered.',
    '- NEVER offer new times after the buyer already accepted a time. That is a critical failure.',
    '- ALWAYS respond with exactly ONE single message. NEVER use bullet points on separate lines. NEVER split into multiple messages. Write everything as one flowing paragraph.',
    '- ALWAYS advance the conversation forward. Never go backwards.',
    '- CONTACT INFO CAPTURE: When the buyer provides an email address or phone number in ANY message, you MUST IMMEDIATELY call update_buyer_info with that info BEFORE writing your response text. This is non-negotiable. Missing contact info = lost deal.',
    '- DEAL INFO CAPTURE: When the buyer mentions financing preference (cash, financing, lease) or a trade-in vehicle, IMMEDIATELY call update_buyer_info with the financing or tradeIn field.',
    '- ACKNOWLEDGMENT: When you receive contact info (email/phone), explicitly acknowledge it in your reply. Example: "Got your email, Romeo!" or "Thanks for the number!" This confirms to the buyer you captured it.',
    '',
    'RESPONSE RULES:',
    '- HARD LIMIT: Your reply text MUST be under 280 characters total. Aim for under 200 characters. Count carefully. If your draft is over 280 characters, shorten it before responding. This is a strict technical limit — messages over 280 chars get cut off and look broken to the buyer.',
    '- NO paragraph-style messages. NO bullet points. NO lists. Just talk like a human.',
    '- Use the buyer\'s name when you have it.',
    '- When you have vehicle details, highlight 2-3 specific selling points.',
    '- When offering appointment times, give exactly 2-3 options from get_available_slots.',
    '- If the buyer gives email/phone, IMMEDIATELY call update_buyer_info BEFORE writing your response. Then acknowledge it.',
    '- After booking an appointment, ALWAYS ask for BOTH email and phone. Ask for whichever you\'re still missing.',
    '- If the conversation involves: angry customer, legal threats, profanity, competitor trade-in negotiation, or anything uncertain → call escalate_to_human.',
    '- Always sound like a real person texting, not a corporate bot.',
    '',
    'CONVERSATION STATE AWARENESS:',
    `- Current state: ${conversation.state || 'NEW'}`,
    '- If NEW: Quick excitement about the car, ask what caught their eye. Call get_vehicle_details.',
    '- If ENGAGED: Casually suggest coming to see it. Use get_available_slots to offer 2-3 times.',
    '- If NEGOTIATING: Focus on value and the experience of seeing it in person.',
    '- If APPOINTMENT_SET: Appointment is booked. Stay warm and responsive. If the buyer wants to reschedule, call cancel_appointment first then book_appointment with the new time. If they provide contact info, capture it immediately. Otherwise, casually ask about their needs - financing questions, trade-in, budget range, or must-have features. Keep it natural like a friendly salesperson checking in, not an interrogation.',
    '',
    'INFO COLLECTION FLOW (follow this order naturally, one per message):',
    'When offering times, ALWAYS lead with today\'s availability. Only mention tomorrow if today is fully booked or buyer explicitly asks for another day.',
    '1. After booking → ask for email: "Let me send you a confirmation with a calendar invite — what\'s your email?"',
    '2. After buyer gives email → IMMEDIATELY call update_buyer_info with the email. The system automatically sends a confirmation email + calendar invite once email + appointment exist.',
    '3. After email is handled → ask for phone: "And best number to reach you day-of?"',
    '4. After phone → soft ask: "Anything I should have ready — financing options, trade-in appraisal?"',
    '5. After that → close warmly: "Perfect, see you at [time]!"',
    'NEVER ask for two things in one message. One question at a time.',
    'The system automatically sends confirmation email + calendar invite when both an appointment and email exist. You do NOT need to send it manually.',
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
    'WHAT HAS ALREADY HAPPENED (DO NOT REPEAT THESE):',
    `- Appointment: ${conversation.state === 'APPOINTMENT_SET' ? 'YES - already booked. Do NOT rebook, do NOT offer new times, do NOT ask "when works for you". Just confirm or answer questions briefly.' : 'Not yet booked - guide toward booking.'}`,
    `- Email: ${conversation.buyerEmail ? 'YES - already captured (' + conversation.buyerEmail + '). Do NOT ask for it again.' : 'Not yet captured - ask for it after booking.'}`,
    `- Phone: ${conversation.buyerPhone ? 'YES - already captured (' + conversation.buyerPhone + '). Do NOT ask for it again.' : 'Not yet captured - ask for it after getting email.'}`,
    `- Confirmation email: ${conversation.state === 'APPOINTMENT_SET' && conversation.buyerEmail ? 'ASSUME ALREADY SENT. Do NOT offer to send another.' : 'Not yet sent.'}`,
    '',
    'STATE MACHINE (follow this strictly, never go backwards):',
    'NEW -> answer inquiry, highlight vehicle, offer 2-3 appointment times',
    'ENGAGED -> buyer showed interest, push toward booking a specific time',
    'APPOINTMENT_SET -> appointment is booked but conversation continues naturally:',
    '  1. If buyer wants to reschedule: call cancel_appointment, then book_appointment with new time',
    '  2. Collect missing contact info (email then phone), ONE at a time',
    '  3. Casually learn about their needs: "Are you looking at financing or paying cash?", "Do you have a trade-in?", "What features matter most to you?"',
    '  4. Answer any questions warmly',
    '  5. Keep it natural - a good salesperson builds rapport, not just collects data',
    '  NEVER say "you\'re all set for [time]" again if you already said it. Check the history.',
    '',
    'ANTI-REPETITION RULE: Before generating your reply, read the last 3 DEALER messages in the history. If your planned response says essentially the same thing as any of them, write something different or shorter. If there is nothing new to say, just say "See you then!" or answer their specific question.',
    '',
    `RIGHT NOW: ${dayOfWeek}, ${today} at ${currentTime}`,
    `TOMORROW: ${tomorrowDay}, ${tomorrowISO}`,
    'NEVER offer or book times in the past. If most of today is gone, offer tomorrow instead.',
    'When referring to days, use the CORRECT day name. Today is ' + dayOfWeek + ', tomorrow is ' + tomorrowDay + '.',
    'Use this when calling get_available_slots. Offer today (if slots remain) or tomorrow.',
    '',
    'EXAMPLE IDEAL CONVERSATION FLOW (study this pattern):',
    'Buyer: "Is this still available?"',
    'You: [call get_vehicle_details + get_available_slots] Enthusiastic intro about the car with 2-3 highlights, offer 2-3 specific appointment times.',
    'Buyer: "2:30 works"',
    'You: [IMMEDIATELY call book_appointment — do NOT re-ask] Confirm booking, then ask: "Let me send you a confirmation with a calendar invite — what\'s your email?"',
    'Buyer: "romeo@gmail.com"',
    'You: [IMMEDIATELY call update_buyer_info with email] "Got your email, Romeo! You should get the confirmation and calendar invite automatically. What\'s the best phone number to reach you at?"',
    'Buyer: "555-123-4567"',
    'You: [IMMEDIATELY call update_buyer_info with phone] "Perfect — see you at 2:30!"',
    '',
    'ANTI-PATTERNS (NEVER do these):',
    '- NEVER say "we just talked about this" or reference conversations that did not happen in the message history above.',
    '- NEVER re-ask a time after the buyer already said a time. "2:30" or "let\'s do 2:30" = BOOK IT NOW.',
    '- NEVER say "just need your email" after the buyer already gave it. READ the messages above.',
    '- NEVER skip asking for phone number. If you have email but not phone, ask for phone. If you have phone but not email, ask for email.',
    '- NEVER generate a response without first checking if the buyer\'s last message contains an email address or phone number.',
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
