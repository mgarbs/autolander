/**
 * Lead Scoring Engine
 *
 * Stateless module that scores and classifies buyer conversations.
 * Zero external deps, <1ms per score.
 *
 * Formula: (stateScore * 0.2) + (intentScore * 0.3) + (signalModifier * 0.4) + base(10)
 * Clamped to 0-100.
 *
 * Signals (what they said/did) get the highest weight because they're the
 * strongest real-time indicator of buying intent. State machine position is
 * a lagging indicator — the buyer may be far ahead of where the engine thinks.
 */

// State scores (from ConversationEngine STATES)
const STATE_SCORES = {
  new: 5,
  availability_confirmed: 15,
  price_discussed: 30,
  trade_in_discussed: 25,
  financing_discussed: 25,
  appointment_offered: 50,
  appointment_selecting: 60,
  appointment_confirmed: 80,
  handoff_needed: 45,
  stale: 2,
  completed: 10
};

// Intent scores (from classifyIntent())
const INTENT_SCORES = {
  ready_to_buy: 40,
  test_drive: 30,
  financing: 25,
  trade_in: 20,
  price_inquiry: 15,
  availability: 10,
  vehicle_details: 10,
  unknown: 5,
  spam: -20
};

// Behavioral signal definitions
const BEHAVIORAL_SIGNALS = [
  {
    id: 'ready_to_buy_intent',
    weight: 45,
    description: 'Buyer has expressed ready-to-buy intent',
    test: (convState) => convState.lastIntent === 'ready_to_buy'
  },
  {
    id: 'appointment_booked',
    weight: 30,
    description: 'Appointment has been confirmed',
    test: (convState) => convState.state === 'appointment_confirmed'
  },
  {
    id: 'test_drive_requested',
    weight: 20,
    description: 'Test drive has been requested',
    test: (convState) => convState.lastIntent === 'test_drive'
  },
  {
    id: 'fast_replies',
    weight: 15,
    description: 'Buyer is replying quickly (3+ messages in <24h)',
    test: (convState, messages) => {
      if (!messages || messages.length < 3) return false;
      const buyerMsgs = messages.filter(m => m.direction === 'incoming');
      if (buyerMsgs.length < 3) return false;
      const recent = buyerMsgs.slice(-3);
      const first = new Date(recent[0].timestamp || recent[0].receivedAt).getTime();
      const last = new Date(recent[recent.length - 1].timestamp || recent[recent.length - 1].receivedAt).getTime();
      return (last - first) < 24 * 60 * 60 * 1000;
    }
  },
  {
    id: 'high_engagement',
    weight: 10,
    description: 'High message count (5+ messages)',
    test: (convState) => (convState.messageCount || 0) >= 5
  },
  {
    id: 'multiple_intents',
    weight: 5,
    description: 'Buyer has shown multiple intent categories',
    test: (convState, messages) => {
      if (!messages || messages.length < 2) return false;
      const intents = new Set();
      for (const m of messages) {
        if (m.intent) intents.add(m.intent);
      }
      return intents.size >= 2;
    }
  },
  {
    id: 're_engaged',
    weight: 15,
    description: 'Buyer re-engaged after >24h silence',
    test: (convState, messages) => {
      if (!messages || messages.length < 2) return false;
      const buyerMsgs = messages.filter(m => m.direction === 'incoming');
      if (buyerMsgs.length < 2) return false;
      const last = buyerMsgs[buyerMsgs.length - 1];
      const prev = buyerMsgs[buyerMsgs.length - 2];
      const lastTime = new Date(last.timestamp || last.receivedAt).getTime();
      const prevTime = new Date(prev.timestamp || prev.receivedAt).getTime();
      return (lastTime - prevTime) > 24 * 60 * 60 * 1000;
    }
  }
];

// Content-based signal patterns (scan last 5 buyer messages)
const CONTENT_SIGNALS = [
  { id: 'cash_mention', weight: 10, description: 'Mentioned paying cash', pattern: /\bcash\b/i },
  { id: 'good_credit', weight: 10, description: 'Mentioned good credit', pattern: /\bgood credit\b|\bcredit score\b|\b[7-8]\d{2}\s*credit/i },
  { id: 'pre_approved', weight: 15, description: 'Pre-approved for financing', pattern: /\bpre[- ]?approved\b/i },
  { id: 'serious_buyer', weight: 15, description: 'Self-identified as serious buyer', pattern: /\bserious buyer\b/i },
  { id: 'willing_to_pay', weight: 12, description: 'Willing to pay asking price', pattern: /\bwilling to pay\b/i },
  { id: 'ready_keyword', weight: 10, description: 'Used ready-to-act language', pattern: /\bready\b/i },
  { id: 'come_in', weight: 15, description: 'Wants to come in / visit', pattern: /\bcome in\b/i },
  { id: 'down_payment', weight: 10, description: 'Mentioned down payment', pattern: /\bdown payment\b|\bput down\b/i },
  { id: 'urgency_today', weight: 25, description: 'Urgency: wants to act today/now', pattern: /\btoday\b|\bright now\b|\basap\b/i },
  { id: 'urgency_soon', weight: 8, description: 'Urgency: wants to act this week', pattern: /\bthis week\b|\btomorrow\b|\bhow soon\b/i },
  { id: 'objection_price', weight: -15, description: 'Price objection', pattern: /\btoo (high|much|expensive)\b|\bcheaper\b/i },
  { id: 'objection_pass', weight: -25, description: 'Not interested / passing', pattern: /\bnot interested\b|\bno thanks\b|\bpass\b/i },
  { id: 'lowball', weight: -20, description: 'Lowball offer language', pattern: /\blowest\b.*\bgo\b|\bbottom dollar\b/i }
];

// Sentiment thresholds
const THRESHOLDS = {
  hot: 60,
  warm: 30,
  cold: 12
};

/**
 * Score a single lead/conversation
 * @param {object} convState - Conversation state from ConversationEngine
 * @param {Array} messages - Array of message objects for this conversation
 * @param {number|null} previousScore - Previous sentiment score for trend detection
 * @returns {object} Score result
 */
function scoreLead(convState, messages, previousScore) {
  if (!convState) {
    return {
      sentiment: 'dead',
      sentimentScore: 0,
      category: 'unknown',
      signals: [],
      summary: 'No conversation data',
      trend: 'new',
      scoredAt: new Date().toISOString(),
      breakdown: { stateScore: 0, intentScore: 0, signalModifier: 0, base: 10 }
    };
  }

  messages = messages || [];
  const base = 10;

  // State score
  const stateScore = STATE_SCORES[convState.state] || 5;

  // Intent score
  const intentScore = INTENT_SCORES[convState.lastIntent] || 5;

  // Behavioral signals
  const signals = [];

  for (const signal of BEHAVIORAL_SIGNALS) {
    if (signal.test(convState, messages)) {
      signals.push({ id: signal.id, weight: signal.weight, description: signal.description });
    }
  }

  // Content signals — scan last 5 buyer messages
  const buyerMessages = messages
    .filter(m => m.direction === 'incoming')
    .slice(-5);

  const combinedText = buyerMessages.map(m => m.text || m.message || '').join(' ');

  for (const signal of CONTENT_SIGNALS) {
    if (signal.pattern.test(combinedText)) {
      signals.push({ id: signal.id, weight: signal.weight, description: signal.description });
    }
  }

  // Calculate signal modifier (sum of signal weights)
  const signalModifier = signals.reduce((sum, s) => sum + s.weight, 0);

  // Final score: (stateScore * 0.2) + (intentScore * 0.3) + (signalModifier * 0.4) + base
  // Signals get highest weight — what the buyer actually says/does is the best indicator
  let sentimentScore = Math.round(
    (stateScore * 0.2) + (intentScore * 0.3) + (signalModifier * 0.4) + base
  );

  // Clamp to 0-100
  sentimentScore = Math.max(0, Math.min(100, sentimentScore));

  // Sentiment classification
  let sentiment;
  if (sentimentScore >= THRESHOLDS.hot) sentiment = 'hot';
  else if (sentimentScore >= THRESHOLDS.warm) sentiment = 'warm';
  else if (sentimentScore >= THRESHOLDS.cold) sentiment = 'cold';
  else sentiment = 'dead';

  // Category
  const category = categorizeLead(convState, signals);

  // Trend
  let trend = 'new';
  if (previousScore != null) {
    const diff = sentimentScore - previousScore;
    if (diff >= 5) trend = 'heating';
    else if (diff <= -5) trend = 'cooling';
    else trend = 'stable';
  }

  // Summary
  const summary = generateSummaryText(convState, signals, sentiment, sentimentScore);

  return {
    sentiment,
    sentimentScore,
    category,
    signals,
    summary,
    trend,
    scoredAt: new Date().toISOString(),
    breakdown: { stateScore, intentScore, signalModifier, base }
  };
}

/**
 * Categorize a lead based on intent and state
 */
function categorizeLead(convState, signals) {
  const state = convState.state || 'new';
  const intent = convState.lastIntent || 'unknown';

  if (intent === 'ready_to_buy' || state === 'appointment_confirmed' || state === 'appointment_selecting') {
    return 'ready_to_buy';
  }
  if (intent === 'test_drive' && (state.includes('appointment') || state === 'appointment_offered')) {
    return 'scheduling';
  }
  if (intent === 'price_inquiry' || intent === 'financing') {
    return 'price_shopping';
  }
  if (intent === 'trade_in') {
    return 'trade_in_inquiry';
  }
  if (intent === 'availability' || intent === 'vehicle_details') {
    // Check for tire kicker: single message + stale
    if ((convState.messageCount || 0) <= 1 && state === 'stale') {
      return 'tire_kicker';
    }
    return 'just_browsing';
  }
  if (intent === 'spam') {
    return 'spam';
  }
  return 'unknown';
}

/**
 * Generate human-readable summary text
 */
function generateSummaryText(convState, signals, sentiment, score) {
  const parts = [];
  const vehicle = convState.vehicleSummary || 'unknown vehicle';
  const intent = convState.lastIntent || 'unknown';

  // Base context
  const intentLabels = {
    ready_to_buy: 'Ready to buy',
    test_drive: 'Wants a test drive',
    financing: 'Asking about financing',
    trade_in: 'Has a trade-in',
    price_inquiry: 'Price shopping',
    availability: 'Checking availability',
    vehicle_details: 'Asking about details',
    unknown: 'General inquiry',
    spam: 'Likely spam'
  };

  parts.push(`${intentLabels[intent] || 'Inquiring'} for ${vehicle}.`);

  // Add signal evidence
  const positiveSignals = signals.filter(s => s.weight > 0);
  const negativeSignals = signals.filter(s => s.weight < 0);

  if (positiveSignals.length > 0) {
    const descriptions = positiveSignals.slice(0, 3).map(s => s.description.toLowerCase());
    parts.push(`Positive: ${descriptions.join(', ')}.`);
  }

  if (negativeSignals.length > 0) {
    const descriptions = negativeSignals.map(s => s.description.toLowerCase());
    parts.push(`Concerns: ${descriptions.join(', ')}.`);
  }

  return parts.join(' ');
}

/**
 * Format lead summary for CLI/Telegram output
 */
function formatLeadSummary(buyerId, convState, score, options = {}) {
  const name = convState.buyerName || parseBuyerName(buyerId);
  const vehicle = convState.vehicleSummary || 'Unknown Vehicle';

  const sentimentEmoji = {
    hot: '\uD83D\uDD25',    // fire
    warm: '\uD83D\uDFE0',   // orange circle
    cold: '\uD83D\uDD35',   // blue circle
    dead: '\u26AB'           // black circle
  };

  const trendArrow = {
    heating: '\u2191',
    cooling: '\u2193',
    stable: '\u2192',
    new: '\u2728'
  };

  const emoji = sentimentEmoji[score.sentiment] || '\u2753';
  const arrow = trendArrow[score.trend] || '';

  const lines = [];
  lines.push(`${emoji} ${score.sentiment.toUpperCase()} ${arrow} (${score.sentimentScore}/100) \u2014 ${score.category}`);
  lines.push(`  Buyer: ${name} | Vehicle: ${vehicle}`);
  lines.push(`  ${score.summary}`);

  if (options.verbose) {
    const bd = score.breakdown;
    lines.push(`  Score: state=${bd.stateScore} + intent=${bd.intentScore} + signals=${bd.signalModifier >= 0 ? '+' : ''}${bd.signalModifier} + base=${bd.base} \u2192 ${score.sentimentScore}`);

    if (score.signals.length > 0) {
      const signalStrs = score.signals.map(s => `${s.id}(${s.weight >= 0 ? '+' : ''}${s.weight})`);
      lines.push(`  Signals: ${signalStrs.join(', ')}`);
    }
  }

  // Last message snippet
  if (options.messages && options.messages.length > 0) {
    const buyerMsgs = options.messages.filter(m => m.direction === 'incoming');
    if (buyerMsgs.length > 0) {
      const last = buyerMsgs[buyerMsgs.length - 1];
      const text = (last.text || last.message || '').substring(0, 80);
      lines.push(`  Last msg: "${text}"`);
    }
  }

  // Meta
  const msgCount = convState.messageCount || 0;
  const state = convState.state || 'new';
  const lastAt = convState.lastMessageAt || convState.createdAt;
  const timeAgo = lastAt ? getTimeAgo(lastAt) : 'unknown';
  lines.push(`  Messages: ${msgCount} | State: ${state} | Last: ${timeAgo}`);

  return lines.join('\n');
}

/**
 * Parse buyer ID into display name
 * buyer_romeo → Romeo
 * test_buyer_123 → Buyer 123
 */
function parseBuyerName(buyerId) {
  if (!buyerId) return 'Unknown';

  // If it's a name-like ID: buyer_romeo → Romeo
  const parts = buyerId.split('_');
  if (parts.length >= 2 && parts[0] === 'buyer') {
    return parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  if (parts.length >= 3 && parts[0] === 'test' && parts[1] === 'buyer') {
    return `Test Buyer ${parts.slice(2).join(' ')}`;
  }

  // Capitalize first letter
  return buyerId.charAt(0).toUpperCase() + buyerId.slice(1);
}

/**
 * Generate a prompt for deep AI analysis of a lead
 */
function analyzeLeadPrompt(convState, messages, score) {
  const vehicle = convState.vehicleSummary || 'Unknown Vehicle';
  const name = convState.buyerName || parseBuyerName(convState.buyerId || 'unknown');

  const msgLog = (messages || []).map(m => {
    const dir = m.direction === 'incoming' ? 'BUYER' : 'BOT';
    return `[${dir}] ${m.text || m.message || ''}`;
  }).join('\n');

  return `Analyze this car buyer lead and provide actionable recommendations.

BUYER: ${name}
VEHICLE: ${vehicle}
STATE: ${convState.state}
SCORE: ${score.sentimentScore}/100 (${score.sentiment})
CATEGORY: ${score.category}
SIGNALS: ${score.signals.map(s => s.description).join(', ') || 'None'}

CONVERSATION:
${msgLog || 'No messages recorded'}

Provide:
1. What is this buyer's likely intent and urgency level?
2. What objections or concerns might they have?
3. What is the recommended next action for the salesperson?
4. Suggested message to send them
5. Probability of closing (low/medium/high) and reasoning`;
}

/**
 * Re-score all conversations
 * @param {object} conversationStates - Map of buyerId → convState
 * @param {function} getMessages - Function(buyerId) that returns messages array
 * @returns {object} Map of buyerId → score
 */
function rescoreAllLeads(conversationStates, getMessages) {
  const scores = {};

  for (const [buyerId, convState] of Object.entries(conversationStates)) {
    const messages = getMessages ? getMessages(buyerId) : [];
    const previousScore = convState.leadScore?.sentimentScore ?? null;
    scores[buyerId] = scoreLead(convState, messages, previousScore);
  }

  return scores;
}

/**
 * Helper: get relative time ago string
 */
function getTimeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

module.exports = {
  scoreLead,
  categorizeLead,
  formatLeadSummary,
  parseBuyerName,
  analyzeLeadPrompt,
  rescoreAllLeads,
  THRESHOLDS,
  STATE_SCORES,
  INTENT_SCORES
};
