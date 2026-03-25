// Configurable base URL for cloud API
// In production builds, VITE_API_URL is baked in at build time
const DEFAULT_API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
let BASE_URL = localStorage.getItem('serverUrl') || DEFAULT_API_URL;

export function setBaseUrl(url) {
  BASE_URL = url;
  localStorage.setItem('serverUrl', url);
  invalidateCache();
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

let _refreshPromise = null;

// Simple time-based cache for API responses
const _apiCache = new Map();
const CACHE_TTL_MS = 15 * 1000; // 15 seconds

function getCached(key) {
  const entry = _apiCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    _apiCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  _apiCache.set(key, { data, time: Date.now() });
}

// Invalidate cache when mutations happen
function invalidateCache(pattern) {
  for (const key of _apiCache.keys()) {
    if (!pattern || key.includes(pattern)) {
      _apiCache.delete(key);
    }
  }
}

async function tryRefreshToken() {
  // Deduplicate concurrent refresh attempts
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.accessToken) {
        localStorage.setItem('accessToken', data.accessToken);
        if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  })();

  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

async function fetchJSON(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const { signal } = options;
  const token = localStorage.getItem('accessToken') || '';
  const cacheKey = `${BASE_URL}${path}::${token}`;

  // Cache GET requests
  if (method === 'GET') {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Invalidate cache on mutations
  if (method !== 'GET') {
    invalidateCache('/api/conversations');
    invalidateCache('/api/vehicles');
  }

  let res = await fetch(`${BASE_URL}${path}`, {
    headers: { ...getAuthHeaders(), ...options.headers },
    ...options,
  });

  // On 401, try refreshing the token and retry once
  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: { ...getAuthHeaders(), ...options.headers },
        ...options,
      });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // If still 401 after refresh attempt, redirect to login
    if (res.status === 401) {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      window.location.hash = '#/login';
    }
    throw new Error(body.error || `API error: ${res.status}`);
  }
  // If the request was aborted while waiting for the body, bail out
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const data = await res.json();
  if (method === 'GET') {
    setCache(cacheKey, data);
  }
  return data;
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
    buyerEmail: conv.buyerEmail || null,
    buyerPhone: conv.buyerPhone || null,
    financingType: conv.financingType || null,
    tradeInDescription: conv.tradeInDescription || null,
    appointment: conv.appointment || null,
    createdAt: conv.createdAt,
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
        listingUrl: v.fbListingUrl || null,
        listingId: v.fbListingId || null,
        stale: v.fbStale || false,
        staleReason: v.fbStaleReason || null,
        staleSince: v.fbStaleSince || null,
        postedPrice: v.fbPostedPrice || null,
      },
    },
  };
}

// --- API functions ---

export async function getStats({ signal } = {}) {
  const [pipeline, vehiclesRes, appointmentsRes] = await Promise.all([
    fetchJSON('/api/conversations/pipeline', { signal }),
    fetchJSON('/api/vehicles', { signal }),
    fetchJSON('/api/appointments', { signal }),
  ]);
  const appts = appointmentsRes.appointments || [];
  const now = new Date();
  const upcoming = appts.filter(a =>
    new Date(a.scheduledTime) >= now && a.status !== 'CANCELLED'
  );
  return {
    todayAppointments: upcoming.length,
    vehicles: vehiclesRes.total || 0,
    posted: (vehiclesRes.vehicles || []).filter(v => v.fbPosted).length,
  };
}

export async function getLeads(params = {}, { signal } = {}) {
  const qs = new URLSearchParams();
  if (params.sentiment) qs.set('sentiment', params.sentiment);
  if (params.limit) qs.set('limit', params.limit);
  const query = qs.toString();
  const data = await fetchJSON(`/api/conversations${query ? '?' + query : ''}`, { signal });
  return (Array.isArray(data) ? data : []).map(toLeadFormat);
}

export async function getLead(id, { signal } = {}) {
  const data = await fetchJSON(`/api/conversations/${encodeURIComponent(id)}`, { signal });
  return toLeadFormat(data);
}

export function archiveConversation(id) {
  return fetchJSON(`/api/conversations/${id}/archive`, { method: 'PUT' });
}

export function getPipeline({ signal } = {}) {
  return fetchJSON('/api/conversations/pipeline', { signal });
}

export function rescoreLeads() {
  return Promise.resolve({ success: true });
}

export function getTeamStats() {
  return getStats();
}

export async function getInventory({ signal } = {}) {
  const data = await fetchJSON('/api/vehicles?status=ACTIVE', { signal });
  return {
    vehicles: (data.vehicles || []).map(toInventoryFormat),
    meta: { total: data.total || 0 },
  };
}

export async function getPostQueue({ signal } = {}) {
  const [unpostedRes, staleRes] = await Promise.all([
    fetchJSON('/api/vehicles?fbPosted=false&status=ACTIVE', { signal }),
    fetchJSON('/api/vehicles?fbPosted=true&fbStale=true&status=ACTIVE', { signal }),
  ]);
  const unposted = (unpostedRes.vehicles || []).map(toInventoryFormat);
  const stale = (staleRes.vehicles || []).map(toInventoryFormat);
  return {
    vehicles: [...unposted, ...stale],
    meta: {
      total: unposted.length + stale.length,
      unposted: unposted.length,
      stale: stale.length,
    },
  };
}

export async function markVehiclePosted({ vehicleId, vin, postUrl, postId, postedAt }) {
  return fetchJSON('/api/vehicles/mark-posted', {
    method: 'PUT',
    body: JSON.stringify({ vehicleId, vin, postUrl, postId, postedAt }),
  });
}

export function markVehicleUpdated(vehicleId) {
  return fetchJSON(`/api/vehicles/${encodeURIComponent(vehicleId)}/mark-updated`, {
    method: 'PUT',
  });
}

export function markVehicleSold(vehicleId) {
  return fetchJSON(`/api/vehicles/${encodeURIComponent(vehicleId)}/mark-sold`, {
    method: 'PUT',
  });
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

export async function deleteFbSession() {
  if (window.autolander?.fb?.deleteSession) {
    return window.autolander.fb.deleteSession();
  }
  return { success: false, error: 'Not available' };
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

export function pauseAutoresponder() {
  return window.autolander?.autoresponder?.pause();
}

export function resumeAutoresponder() {
  return window.autolander?.autoresponder?.resume();
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

export function updateFeed(feedId, data) {
  return fetchJSON(`/api/feeds/${feedId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteFeed(feedId) {
  return fetchJSON(`/api/feeds/${feedId}`, { method: 'DELETE' });
}

export function clearFeedVehicles(feedId) {
  return fetchJSON(`/api/feeds/${feedId}/vehicles`, { method: 'DELETE' });
}

export function syncFeed(feedId) {
  return fetchJSON(`/api/feeds/${feedId}/sync`, { method: 'POST' });
}

export function syncFeedHtml(feedId, html) {
  return fetchJSON(`/api/feeds/${feedId}/sync-html`, {
    method: 'POST',
    body: JSON.stringify({ html }),
  });
}

// --- Gmail Config ---

export function saveGmailConfig({ address, appPassword }) {
  return fetchJSON('/api/dealer-config/email', {
    method: 'PUT',
    body: JSON.stringify({ address, appPassword }),
  });
}

export function getEmailStatus() {
  return fetchJSON('/api/dealer-config/email-status');
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

// --- Dealer Contact ---

export function getDealerContact() {
  return fetchJSON('/api/dealer-config/contact');
}

export function saveDealerContact({ address, phone }) {
  return fetchJSON('/api/dealer-config/contact', {
    method: 'PUT',
    body: JSON.stringify({ address, phone }),
  });
}
