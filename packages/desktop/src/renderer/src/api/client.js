// Configurable base URL for cloud API
let BASE_URL = localStorage.getItem('serverUrl') || 'http://localhost:3000';

export function setBaseUrl(url) {
  BASE_URL = url;
  localStorage.setItem('serverUrl', url);
}

export function getBaseUrl() {
  return BASE_URL;
}

function getAuthHeaders() {
  const token = localStorage.getItem('accessToken');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function fetchJSON(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

// --- Response transformers ---

function scoreToSentiment(score) {
  if (score >= 70) return 'positive';
  if (score >= 45) return 'neutral';
  return 'negative';
}

function scoreToCategory(score) {
  if (score >= 70) return 'HOT';
  if (score >= 45) return 'WARM';
  if (score >= 20) return 'COLD';
  return 'DEAD';
}

function toLeadFormat(conv) {
  const score = conv.leadScore || 0;
  return {
    id: conv.id,
    buyerId: conv.buyerId || conv.id,
    buyerName: conv.buyerName,
    score,
    sentimentScore: score,
    state: (conv.state || 'NEW').toLowerCase(),
    vehicleSummary: conv.vehicle
      ? `${conv.vehicle.year} ${conv.vehicle.make} ${conv.vehicle.model}`
      : 'N/A',
    vehicleInfo: conv.vehicle || null,
    messages: (conv.messages || []).map(m => ({
      role: m.direction === 'INBOUND' ? 'buyer' : 'response',
      text: m.text,
      timestamp: m.createdAt,
    })),
    messageCount: (conv.messages || []).length,
    lastMessageAt: conv.lastMessageAt,
    leadScore: {
      sentimentScore: score,
      sentiment: scoreToSentiment(score),
      category: scoreToCategory(score),
      summary: score >= 70
        ? 'High-intent buyer showing strong purchase signals.'
        : score >= 45
          ? 'Engaged prospect, monitor for buying signals.'
          : 'Early-stage lead, needs nurturing.',
      breakdown: {
        stateScore: Math.min(score * 0.5, 50),
        intentScore: Math.min(score * 0.3, 30),
        signalScore: Math.min(score * 0.2, 20),
      },
      signals: [],
    },
    sentiment: scoreToSentiment(score),
  };
}

function toInventoryFormat(v) {
  return {
    ...v,
    body_style: v.bodyStyle || 'N/A',
    exterior_color: v.color || 'N/A',
    status: (v.status || 'ACTIVE').toLowerCase() === 'active' ? 'available' :
            v.status.toLowerCase() === 'archived' ? 'sold' :
            v.status.toLowerCase(),
    listings: {
      facebook_marketplace: {
        posted: v.fbPosted || false,
        postedAt: v.fbPostDate,
      },
    },
  };
}

// --- API functions ---

export async function getStats() {
  const [pipeline, vehiclesRes, appointmentsRes] = await Promise.all([
    fetchJSON('/api/conversations/pipeline'),
    fetchJSON('/api/vehicles'),
    fetchJSON('/api/appointments'),
  ]);
  const appts = appointmentsRes.appointments || [];
  const todayStr = new Date().toDateString();
  return {
    todayAppointments: appts.filter(a =>
      new Date(a.scheduledTime).toDateString() === todayStr
    ).length,
    vehicles: vehiclesRes.total || 0,
    posted: (vehiclesRes.vehicles || []).filter(v => v.fbPosted).length,
  };
}

export async function getLeads(params = {}) {
  const qs = new URLSearchParams();
  if (params.sentiment) qs.set('sentiment', params.sentiment);
  if (params.limit) qs.set('limit', params.limit);
  const query = qs.toString();
  const data = await fetchJSON(`/api/conversations${query ? '?' + query : ''}`);
  return (Array.isArray(data) ? data : []).map(toLeadFormat);
}

export async function getLead(id) {
  const data = await fetchJSON(`/api/conversations/${encodeURIComponent(id)}`);
  return toLeadFormat(data);
}

export function getPipeline() {
  return fetchJSON('/api/conversations/pipeline');
}

export function rescoreLeads() {
  return Promise.resolve({ success: true });
}

export function getTeamStats() {
  return getStats();
}

export async function getInventory() {
  const data = await fetchJSON('/api/vehicles');
  return {
    vehicles: (data.vehicles || []).map(toInventoryFormat),
    meta: { total: data.total || 0 },
  };
}

// --- FB operations (via IPC bridge in Electron) ---

export async function getFbStatus() {
  if (window.autolander?.fb) {
    return window.autolander.fb.getStatus();
  }
  return { loggedIn: false, message: 'Desktop agent not available.' };
}

export async function getFbAuthStatus() {
  if (window.autolander?.fb) {
    return window.autolander.fb.getStatus();
  }
  return { active: false };
}

export function deleteFbSession() {
  return Promise.resolve({ success: true });
}

export async function startAssistedPost(vin) {
  if (window.autolander?.fb) {
    return window.autolander.fb.startAssistedPost({ vehicle: { vin } });
  }
  return { error: 'Desktop agent not available.' };
}

export function getPostSessionStatus() {
  return Promise.resolve({ active: false });
}

export function cancelPostSession() {
  if (window.autolander?.fb) {
    return window.autolander.fb.cancelAssistedPost();
  }
  return Promise.resolve({ success: true });
}

// --- Dealer Config ---

export function getDealerConfig() {
  return fetchJSON('/api/dealer-config');
}

export function saveDealerConfig({ url, name, enabled, autoGenerate }) {
  return fetchJSON('/api/dealer-config', {
    method: 'PUT',
    body: JSON.stringify({ url, name, scrapeEnabled: enabled, autoGenerate }),
  });
}

export function triggerSync() {
  return fetchJSON('/api/dealer-config/sync', { method: 'POST' });
}

export function getSyncProgress() {
  return Promise.resolve({ inProgress: false, progress: null });
}

// --- Feeds ---

export function getFeeds() {
  return fetchJSON('/api/feeds');
}

export function createFeed(data) {
  return fetchJSON('/api/feeds', { method: 'POST', body: JSON.stringify(data) });
}

export function syncFeed(feedId) {
  return fetchJSON(`/api/feeds/${feedId}/sync`, { method: 'POST' });
}

// --- Google Services ---

export function getGoogleStatus() {
  return fetchJSON('/api/google/status');
}

export function uploadGoogleCredentials(json) {
  return fetchJSON('/api/google/credentials', {
    method: 'POST',
    body: JSON.stringify(json),
  });
}

export function getGoogleAuthUrl() {
  return fetchJSON('/api/google/auth-url');
}

export function disconnectGoogle() {
  return fetchJSON('/api/google/token', { method: 'DELETE' });
}

export function saveGmailConfig({ address, appPassword }) {
  return fetchJSON('/api/google/email', {
    method: 'PUT',
    body: JSON.stringify({ address, appPassword }),
  });
}

// --- AI ---

export function generateListing(vehicleId) {
  return fetchJSON('/api/ai/generate-listing', {
    method: 'POST',
    body: JSON.stringify({ vehicleId }),
  });
}

export function generateResponse(conversationId, buyerMessage) {
  return fetchJSON('/api/ai/generate-response', {
    method: 'POST',
    body: JSON.stringify({ conversationId, buyerMessage }),
  });
}
