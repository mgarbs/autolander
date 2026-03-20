/**
 * Facebook Marketplace Inbox Monitor
 *
 * Puppeteer-based scraper that reads buyer messages from FB Marketplace
 * selling inbox and sends responses through Messenger.
 *
 * Reuses browser init, session/cookie management, stealth plugin, and
 * humanDelay() patterns from facebook-poster.js.
 */

const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR, SCREENSHOTS_DIR, ensureDirs } = require('./paths');
const { SharedBrowser } = require('./shared-browser');

ensureDirs();

/**
 * Random delay to mimic human behavior
 */
async function humanDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

class InboxMonitor {
  constructor(options = {}) {
    this.salespersonId = options.salespersonId || 'default';
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.sessionFile = path.join(SESSIONS_DIR, `${this.salespersonId}_fb_session.json`);
    this._consecutiveErrors = 0;
    this._usingMessenger = false; // true when fallen back to Messenger
    this._graphqlThreads = [];
    this._responseInterceptionSetup = false;
    this._responseHandler = null;
  }

  /**
   * Initialize browser via SharedBrowser.
   * Acquires the shared Chrome instance and opens an inbox tab.
   */
  async init() {
    if (SharedBrowser.isAuthActive(this.salespersonId)) {
      throw new Error('Login in progress — please wait for auth to complete');
    }

    console.log('[inbox-monitor] Initializing browser via SharedBrowser...');

    const slot = await SharedBrowser.acquire(this.salespersonId);
    this.browser = slot.browser;

    this.page = await SharedBrowser.getPage(this.salespersonId, 'inbox');
    this._setupResponseInterception();

    // Load saved cookies as fallback for fresh profiles
    await this.loadSession();

    console.log('[inbox-monitor] Browser initialized (shared)');
    return this;
  }

  _setupResponseInterception() {
    if (!this.page || this._responseInterceptionSetup) return;

    this._responseHandler = async (response) => {
      try {
        const url = response.url();
        if (response.status() !== 200) return;
        if (!/graphql|\/api\/graphql\//i.test(url)) return;

        const body = await response.text();
        if (!body || body.length < 2) return;

        const payloads = this._parseJsonPayloads(body);
        for (const payload of payloads) {
          this._collectGraphqlThreads(payload);
        }
      } catch {
        // Best-effort only. DOM parsing remains the fallback path.
      }
    };

    this.page.on('response', this._responseHandler);
    this._responseInterceptionSetup = true;
  }

  _parseJsonPayloads(rawText) {
    const cleaned = (rawText || '')
      .replace(/^\s*for\s*\(;;\);\s*/, '')
      .replace(/^\s*while\s*\(1\);\s*/, '')
      .trim();

    if (!cleaned) return [];

    const direct = this._tryParseJson(cleaned);
    if (typeof direct !== 'undefined') {
      return [direct];
    }

    const payloads = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < cleaned.length; i += 1) {
      const char = cleaned[i];

      if (start === -1) {
        if (char === '{' || char === '[') {
          start = i;
          depth = 1;
          inString = false;
          escape = false;
        }
        continue;
      }

      if (inString) {
        if (escape) {
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') depth += 1;
      if (char === '}' || char === ']') depth -= 1;

      if (depth === 0) {
        const parsed = this._tryParseJson(cleaned.slice(start, i + 1));
        if (typeof parsed !== 'undefined') {
          payloads.push(parsed);
        }
        start = -1;
      }
    }

    return payloads;
  }

  _tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  _collectGraphqlThreads(payload) {
    const inspect = (candidate) => {
      const thread = this._extractGraphqlThread(candidate);
      if (thread) {
        this._upsertGraphqlThread(thread);
      }
    };

    inspect(payload);

    this._walkJson(payload, (_key, value) => {
      inspect(value);

      if (Array.isArray(value)) {
        for (const item of value) {
          inspect(item);
          if (item && typeof item === 'object' && item.node) {
            inspect(item.node);
          }
        }
      } else if (value && typeof value === 'object' && value.node) {
        inspect(value.node);
      }
    });
  }

  _upsertGraphqlThread(thread) {
    const threadId = this._buildSyntheticThreadId(
      thread.buyerName,
      thread.listingTitle,
      thread.realThreadId
    );
    const next = {
      threadId,
      buyerName: thread.buyerName || 'Unknown',
      listingTitle: thread.listingTitle || '',
      lastMessage: thread.lastMessage || '',
      unread: typeof thread.unread === 'boolean' ? thread.unread : true,
      timestamp: thread.timestamp || '',
      realThreadId: thread.realThreadId || '',
      _realFbId: thread.realThreadId || '',
    };

    const idx = this._graphqlThreads.findIndex((existing) => {
      if (next.realThreadId && existing.realThreadId) {
        return existing.realThreadId === next.realThreadId;
      }
      return existing.threadId === next.threadId;
    });

    if (idx === -1) {
      this._graphqlThreads.push(next);
      return;
    }

    const existing = this._graphqlThreads[idx];
    this._graphqlThreads[idx] = {
      ...existing,
      ...next,
      buyerName: next.buyerName || existing.buyerName,
      listingTitle: next.listingTitle || existing.listingTitle,
      lastMessage: next.lastMessage || existing.lastMessage,
      timestamp: next.timestamp || existing.timestamp,
      unread: typeof next.unread === 'boolean' ? next.unread : existing.unread,
    };
  }

  _extractGraphqlThread(candidate) {
    const obj = this._unwrapGraphqlThreadCandidate(candidate);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (!this._looksLikeGraphqlThread(obj)) return null;

    const realThreadId = this._extractThreadNumericId(obj.thread_key)
      || this._extractThreadNumericId(obj.thread_id)
      || this._extractThreadNumericId(obj.threadId)
      || this._extractThreadNumericId(obj.id)
      || this._extractThreadNumericId(obj.thread_fbid);
    const buyerName = this._extractGraphqlBuyerName(obj);
    const listingTitle = this._extractGraphqlListingTitle(obj);
    const lastMessage = this._extractGraphqlLastMessage(obj);
    const unread = this._extractGraphqlUnread(obj);
    const timestamp = this._extractGraphqlTimestamp(obj);

    if (!realThreadId && !buyerName && !lastMessage) return null;

    return {
      realThreadId: realThreadId || '',
      buyerName: buyerName || 'Unknown',
      listingTitle: listingTitle || '',
      lastMessage: lastMessage || '',
      unread,
      timestamp: timestamp || '',
    };
  }

  _unwrapGraphqlThreadCandidate(candidate, depth = 0) {
    if (depth > 3 || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return candidate;
    }

    if (candidate.node && typeof candidate.node === 'object') {
      return this._unwrapGraphqlThreadCandidate(candidate.node, depth + 1);
    }
    if (candidate.thread && typeof candidate.thread === 'object') {
      return this._unwrapGraphqlThreadCandidate(candidate.thread, depth + 1);
    }
    if (candidate.conversation && typeof candidate.conversation === 'object') {
      return this._unwrapGraphqlThreadCandidate(candidate.conversation, depth + 1);
    }

    return candidate;
  }

  _looksLikeGraphqlThread(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

    const keys = Object.keys(obj).map(key => key.toLowerCase());
    let signals = 0;

    if (
      keys.includes('thread_key')
      || keys.includes('thread_id')
      || keys.includes('threadid')
      || keys.includes('thread_fbid')
      || this._extractThreadNumericId(obj.thread_key)
      || this._extractThreadNumericId(obj.thread_id)
      || this._extractThreadNumericId(obj.threadId)
    ) {
      signals += 1;
    }
    if (keys.some(key => key.includes('participant') || key === 'participants')) signals += 1;
    if (keys.some(key => key.includes('message') || key === 'snippet')) signals += 1;
    if (keys.some(key => key.includes('commerce') || key.includes('marketplace') || key === 'listing')) signals += 1;
    if (keys.some(key => key.includes('unread') || key.includes('read_receipt'))) signals += 1;

    return signals >= 2;
  }

  _extractGraphqlBuyerName(obj) {
    const participantFields = [
      'other_participants',
      'participants',
      'all_participants',
      'thread_participants',
      'participant_list',
      'actors',
      'users',
    ];
    let fallback = '';

    for (const field of participantFields) {
      const participants = this._flattenCollection(obj[field]);
      for (const participant of participants) {
        const candidate = participant?.messaging_actor || participant?.actor || participant?.user || participant?.participant || participant;
        const name = this._extractFieldString(candidate, ['name', 'short_name', 'full_name', 'display_name']);
        if (!name) continue;
        if (!fallback) fallback = name;

        const isSelf = Boolean(
          participant?.is_self
          || participant?.is_viewer
          || candidate?.is_self
          || candidate?.is_viewer
          || participant?.is_own_profile
          || candidate?.is_own_profile
        );
        if (!isSelf) {
          return name;
        }
      }
    }

    return fallback;
  }

  _extractGraphqlListingTitle(obj) {
    const directFields = [
      obj.listing_title,
      obj.marketplace_listing_title,
      obj.commerce_product_title,
    ];

    for (const value of directFields) {
      const text = this._extractString(value);
      if (text && text.length < 160 && !/^\$[\d,]+/.test(text)) {
        return text;
      }
    }

    const containers = [
      obj.marketplace_listing,
      obj.listing,
      obj.commerce_product,
      obj.marketplace_thread_data,
      obj.commerce_thread,
      obj.extensible_attachment,
    ];

    for (const container of containers) {
      const text = this._extractFieldString(container, [
        'title',
        'name',
        'listing_title',
        'marketplace_listing_title',
        'text',
      ]);
      if (text && text.length < 160 && !/^\$[\d,]+/.test(text)) {
        return text;
      }
    }

    return '';
  }

  _extractGraphqlLastMessage(obj) {
    const direct = [
      this._extractString(obj.snippet),
      this._extractFieldString(obj.last_message, ['text', 'snippet', 'message', 'body']),
      this._extractFieldString(obj.last_sent_message, ['text', 'snippet', 'message', 'body']),
      this._extractFieldString(obj.messages, ['text', 'snippet', 'message', 'body']),
    ];

    for (const candidate of direct) {
      if (candidate) return candidate;
    }

    const messageCollections = [
      obj.last_message,
      obj.last_sent_message,
      obj.messages,
    ];

    for (const value of messageCollections) {
      const items = this._flattenCollection(value);
      for (const item of items) {
        const text = this._extractFieldString(item, ['text', 'snippet', 'message', 'body']);
        if (text) return text;
      }
    }

    return '';
  }

  _extractGraphqlUnread(obj) {
    if (typeof obj.unread === 'boolean') return obj.unread;
    if (typeof obj.is_unread === 'boolean') return obj.is_unread;

    const unreadCount = this._extractNumber(obj.unread_count);
    if (typeof unreadCount === 'number') {
      return unreadCount > 0;
    }

    const lastMessageTs = this._extractNumber(obj.updated_time_precise)
      || this._extractNumber(obj.last_message_timestamp)
      || this._extractNumber(obj.timestamp);
    const lastReadTs = this._extractNumber(obj.last_read_timestamp)
      || this._extractNumber(obj.viewer_last_read_timestamp);

    if (lastMessageTs && lastReadTs) {
      return lastMessageTs > lastReadTs;
    }

    return true;
  }

  _extractGraphqlTimestamp(obj) {
    const candidates = [
      obj.updated_time_precise,
      obj.updated_time,
      obj.last_message_timestamp,
      obj.last_activity_timestamp,
      obj.timestamp,
    ];

    for (const candidate of candidates) {
      const numeric = this._extractNumber(candidate);
      if (typeof numeric === 'number') return String(numeric);

      const text = this._extractString(candidate);
      if (text) return text;
    }

    return '';
  }

  _extractThreadNumericId(value, depth = 0) {
    if (depth > 6 || value == null) return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(Math.trunc(value));
    }

    if (typeof value === 'string') {
      const match = value.match(/\d{6,}/);
      return match ? match[0] : '';
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const id = this._extractThreadNumericId(item, depth + 1);
        if (id) return id;
      }
      return '';
    }

    if (typeof value !== 'object') return '';

    for (const key of ['thread_fbid', 'thread_id', 'threadId', 'id', 'other_user_id', 'value']) {
      const id = this._extractThreadNumericId(value[key], depth + 1);
      if (id) return id;
    }

    for (const nested of Object.values(value)) {
      const id = this._extractThreadNumericId(nested, depth + 1);
      if (id) return id;
    }

    return '';
  }

  _flattenCollection(value, depth = 0) {
    if (depth > 6 || value == null) return [];

    if (Array.isArray(value)) {
      return value.flatMap(item => this._flattenCollection(item, depth + 1));
    }

    if (typeof value !== 'object') return [];

    if (Array.isArray(value.nodes)) {
      return this._flattenCollection(value.nodes, depth + 1);
    }

    if (Array.isArray(value.edges)) {
      return value.edges.flatMap(edge => this._flattenCollection(edge?.node || edge, depth + 1));
    }

    if (value.node && typeof value.node === 'object') {
      return this._flattenCollection(value.node, depth + 1);
    }

    return [value];
  }

  _extractFieldString(obj, fields) {
    if (!obj || typeof obj !== 'object') return '';

    for (const field of fields) {
      const text = this._extractString(obj[field]);
      if (text) return text;
    }

    return '';
  }

  _extractString(value, depth = 0) {
    if (depth > 6 || value == null) return '';

    if (typeof value === 'string') {
      return value.trim();
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const text = this._extractString(item, depth + 1);
        if (text) return text;
      }
      return '';
    }

    if (typeof value !== 'object') return '';

    const preferredKeys = [
      'text',
      'snippet',
      'message',
      'body',
      'title',
      'name',
      'short_name',
      'full_name',
      'display_name',
    ];

    for (const key of preferredKeys) {
      const text = this._extractString(value[key], depth + 1);
      if (text) return text;
    }

    return '';
  }

  _extractNumber(value, depth = 0) {
    if (depth > 6 || value == null) return null;

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const match = value.match(/\d+/);
      return match ? Number(match[0]) : null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const num = this._extractNumber(item, depth + 1);
        if (typeof num === 'number') return num;
      }
      return null;
    }

    if (typeof value !== 'object') return null;

    for (const key of ['count', 'value', 'timestamp', 'time', 'time_in_seconds']) {
      const num = this._extractNumber(value[key], depth + 1);
      if (typeof num === 'number') return num;
    }

    return null;
  }

  _buildSyntheticThreadId(buyerName, listingTitle, fallbackSuffix = '') {
    const buyerSlug = this._slugify(buyerName) || 'unknown';
    const listingSlug = listingTitle ? this._slugify(listingTitle).substring(0, 50) : '';
    const suffix = listingSlug || (fallbackSuffix ? String(fallbackSuffix) : '');
    return suffix ? `inbox_${buyerSlug}_${suffix}` : `inbox_${buyerSlug}`;
  }

  _slugify(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  _normalizeText(text) {
    return (text || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  _walkJson(obj, callback, depth = 0) {
    if (depth > 15 || !obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      callback(key, value);
      if (typeof value === 'object' && value !== null) {
        this._walkJson(value, callback, depth + 1);
      }
    }
  }

  /**
   * Save session cookies
   */
  async saveSession() {
    if (!this.page) return;
    const cookies = await this.page.cookies();
    const sessionData = {
      cookies,
      savedAt: new Date().toISOString(),
      salespersonId: this.salespersonId
    };
    fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2));
    console.log('[inbox-monitor] Session saved');
  }

  /**
   * Load session cookies
   */
  async loadSession() {
    if (!fs.existsSync(this.sessionFile)) {
      console.log('[inbox-monitor] No saved session found');
      return false;
    }

    try {
      const sessionData = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      const savedAt = new Date(sessionData.savedAt);
      const daysSince = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSince > 7) {
        console.log('[inbox-monitor] Session expired');
        return false;
      }

      await this.page.setCookie(...sessionData.cookies);
      console.log('[inbox-monitor] Session loaded');
      return true;
    } catch (e) {
      console.log('[inbox-monitor] Failed to load session:', e.message);
      return false;
    }
  }

  /**
   * Check if logged in
   */
  async checkLoginStatus() {
    try {
      await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
      await humanDelay(2000, 4000);

      const loginForm = await this.page.$('input[name="email"]');
      const userMenu = await this.page.$('[aria-label="Your profile"]');

      this.isLoggedIn = !loginForm && !!userMenu;
      console.log(`[inbox-monitor] Login status: ${this.isLoggedIn ? 'logged in' : 'not logged in'}`);
      return this.isLoggedIn;
    } catch (e) {
      console.error('[inbox-monitor] Login check error:', e.message);
      return false;
    }
  }

  /**
   * Dismiss overlay dialogs — same as facebook-poster.js:520-553
   */
  async dismissOverlays() {
    const dismissed = await this.page.evaluate(() => {
      const closed = [];
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.offsetParent === null) continue;
        for (const btn of dialog.querySelectorAll('[role="button"], button, [aria-label="Close"]')) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (label === 'close' || text === 'close' || text === 'not now' ||
              text === 'skip' || text === 'x' || text === 'dismiss' ||
              text === 'got it' || text === 'ok') {
            btn.click();
            closed.push(text || label);
            break;
          }
        }
      }
      return closed;
    });
    if (dismissed.length > 0) {
      console.log(`[inbox-monitor] Dismissed overlays: ${dismissed.join(', ')}`);
      await new Promise(r => setTimeout(r, 500));
    }
    await this.page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
  }

  /**
   * Navigate to the Marketplace inbox (buyer/seller conversations).
   *
   * FB Marketplace (2026) conversation URL: facebook.com/marketplace/inbox/
   * This shows the "Selling" tab with conversation rows like:
   *   "BuyerName · ListingTitle  MessagePreview  Timestamp"
   * Clicking a row opens the chat panel on the right side.
   */
  async navigateToInbox() {
    this._graphqlThreads = [];

    if (this._consecutiveErrors > 0) {
      this._consecutiveErrors += 1;
      if (this._consecutiveErrors % 10 !== 0) {
        console.warn(`[inbox-monitor] Marketplace inbox still rate-limited (${this._consecutiveErrors} consecutive errors) - using Messenger directly`);
        return this._navigateViaMessenger();
      }
      console.log(`[inbox-monitor] Retrying Marketplace inbox after ${this._consecutiveErrors} consecutive errors...`);
    }

    console.log('[inbox-monitor] Navigating to Marketplace inbox...');

    // Close Marketplace chat panels before navigating (they persist across pages)
    // Only target "Close chat" — NOT generic "close" which hits Messenger/Notifications
    const stacked = await this.page.evaluate(() => {
      const closed = [];
      for (const btn of document.querySelectorAll('[aria-label="Close chat"]')) {
        if (btn.offsetParent !== null) { btn.click(); closed.push('Close chat'); }
      }
      return closed;
    });
    if (stacked.length > 0) {
      console.log(`[inbox-monitor] Closed ${stacked.length} chat panel(s) before navigation`);
      await new Promise(r => setTimeout(r, 800));
    }

    await this.page.goto('https://www.facebook.com/marketplace/inbox/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await humanDelay(2000, 4000);
    await this.dismissOverlays();

    // Close Marketplace chat panels that re-appeared after page load
    const stackedAfter = await this.page.evaluate(() => {
      const closed = [];
      for (const btn of document.querySelectorAll('[aria-label="Close chat"]')) {
        if (btn.offsetParent !== null) { btn.click(); closed.push('Close chat'); }
      }
      return closed;
    });
    if (stackedAfter.length > 0) {
      console.log(`[inbox-monitor] Closed ${stackedAfter.length} chat panel(s) after page load`);
      await new Promise(r => setTimeout(r, 800));
    }

    // Detect "Temporarily Blocked" page — check multiple sources since FB renders
    // the block message via React and innerText may not pick it up immediately
    const blocked = await this.page.evaluate(() => {
      // Check textContent (more reliable than innerText for React content)
      const bodyText = document.body?.textContent || '';
      if (bodyText.includes('Temporarily Blocked') || bodyText.includes('temporarily blocked')) return true;
      // Check for the "Reload page" button which appears on block pages
      const buttons = document.querySelectorAll('[role="button"]');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === 'Reload page') return true;
      }
      return false;
    });
    if (blocked) {
      console.error('[inbox-monitor] BLOCKED: Facebook has temporarily blocked this account. Backing off.');
      await this.takeScreenshot('fb_blocked');
      throw new Error('Facebook temporarily blocked — too many actions too fast. Wait 15-30 minutes.');
    }

    // The /marketplace/inbox/ page defaults to the "Selling" tab.
    // If we're somehow on "Buying", click the Selling tab — but ONLY
    // target [role="tab"] elements to avoid hitting sidebar links that
    // navigate away from the inbox page.
    const onBuyingTab = await this.page.evaluate(() => {
      for (const tab of document.querySelectorAll('[role="tab"]')) {
        const text = tab.textContent?.trim();
        if (text === 'Buying' && tab.getAttribute('aria-selected') === 'true') return true;
      }
      return false;
    });

    if (onBuyingTab) {
      console.log('[inbox-monitor] On Buying tab — switching to Selling...');
      const switched = await this.page.evaluate(() => {
        for (const tab of document.querySelectorAll('[role="tab"]')) {
          if (tab.textContent?.trim() === 'Selling') {
            tab.click();
            return true;
          }
        }
        return false;
      });
      if (switched) {
        await humanDelay(1500, 3000);
      }
    }

    // Detect "Sorry, something went wrong" error page
    const hasSWWError = await this.page.evaluate(() => {
      const bodyText = document.body?.textContent || '';
      return bodyText.includes('Sorry, something went wrong');
    });

    if (hasSWWError) {
      if (this._consecutiveErrors === 0) {
        this._consecutiveErrors = 1;
      }
      console.warn(`[inbox-monitor] FB showed "Something went wrong" (consecutive: ${this._consecutiveErrors}) — falling back to Messenger...`);

      // Fall back to Facebook Messenger — Marketplace conversations appear there too
      return this._navigateViaMessenger();
    }

    this._consecutiveErrors = 0;
    this._usingMessenger = false;
    await this.takeScreenshot('inbox_loaded');
    console.log('[inbox-monitor] On Marketplace inbox page');
    return true;
  }

  /**
   * Fall back to Facebook Messenger when Marketplace inbox is broken.
   * Marketplace conversations appear in Messenger with listing context.
   */
  async _navigateViaMessenger() {
    console.log('[inbox-monitor] Navigating to Facebook Messenger as fallback...');

    await this.page.goto('https://www.facebook.com/messages/t/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await humanDelay(3000, 5000);
    await this.dismissOverlays();

    // Dismiss "Send a one-time code to restore your chat history" dialog
    // This dialog has an X button and a "Send code" button. We want the X.
    await this._dismissMessengerDialogs();

    // Click the "Marketplace" entry in the sidebar — this is where all
    // Marketplace conversations are grouped. Don't click personal chats.
    const clickedMP = await this.page.evaluate(() => {
      // The Marketplace entry has a store/building icon and text "Marketplace"
      // It also shows "X new messages" badge
      const allElements = document.querySelectorAll('a, div[role="row"], div[role="listitem"], [role="button"]');
      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const rect = el.getBoundingClientRect();
        // Must be in left sidebar (x < 400)
        if (rect.x > 400 || rect.width < 50) continue;

        const text = el.textContent?.trim() || '';
        if (text.includes('Marketplace') && text.includes('new message')) {
          el.click();
          return text.substring(0, 60);
        }
      }
      // Fallback: just look for "Marketplace" text
      for (const el of allElements) {
        if (el.offsetParent === null) continue;
        const rect = el.getBoundingClientRect();
        if (rect.x > 400 || rect.width < 50) continue;
        const text = el.textContent?.trim() || '';
        if (/^Marketplace/i.test(text) && text.length < 100) {
          el.click();
          return text.substring(0, 60);
        }
      }
      return null;
    });

    if (clickedMP) {
      console.log(`[inbox-monitor] Clicked Marketplace entry: ${clickedMP}`);
      await humanDelay(3000, 5000);
      await this._dismissMessengerDialogs();
    } else {
      console.warn('[inbox-monitor] Could not find Marketplace entry in Messenger sidebar');
    }

    this._usingMessenger = true;
    await this.takeScreenshot('messenger_loaded');
    console.log('[inbox-monitor] On Facebook Messenger — Marketplace view');
    return true;
  }

  async _dismissMessengerDialogs() {
    const hasDialog = await this.page.evaluate(() => {
      const body = (document.body?.textContent || '').toLowerCase();
      return body.includes('restore your chat history') || body.includes('one-time code');
    });
    if (!hasDialog) return;

    console.log('[inbox-monitor] "Restore chat history" dialog detected - dismissing...');

    await this.page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 1500));

    let gone = await this.page.evaluate(() => {
      const body = (document.body?.textContent || '').toLowerCase();
      return !body.includes('restore your chat history') && !body.includes('one-time code');
    });
    if (gone) {
      console.log('[inbox-monitor] Dialog dismissed via Escape');
      return;
    }

    const dialogState = await this.page.evaluate(() => {
      const normalize = (value) => (value || '').toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const text = normalize(node.textContent);
          return text.includes('restore your chat history') || text.includes('one-time code')
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      });
      const textNode = walker.nextNode();
      if (!textNode) return null;

      let dialog = textNode.parentElement;
      for (let i = 0; i < 15; i += 1) {
        if (!dialog) break;
        const rect = dialog.getBoundingClientRect();
        if (rect.width > 350 && rect.width < 700 && rect.height > 200 && rect.height < 500) {
          break;
        }
        dialog = dialog.parentElement;
      }
      if (!dialog) return null;

      const rect = dialog.getBoundingClientRect();
      const upperRightMinX = rect.left + (rect.width * 0.55);
      const upperRightMaxY = rect.top + (rect.height * 0.45);

      let svgClose = null;
      for (const svg of dialog.querySelectorAll('svg')) {
        const svgRect = svg.getBoundingClientRect();
        if (svgRect.width < 1 || svgRect.height < 1) continue;
        if (svgRect.width >= 50 || svgRect.height >= 50) continue;
        if (svgRect.left < upperRightMinX || svgRect.top > upperRightMaxY) continue;
        svgClose = {
          x: svgRect.left + (svgRect.width / 2),
          y: svgRect.top + (svgRect.height / 2),
        };
        break;
      }

      let labeledClose = null;
      for (const el of dialog.querySelectorAll('[aria-label], button, [role="button"]')) {
        if (el.offsetParent === null) continue;
        const label = normalize(el.getAttribute('aria-label'));
        const text = normalize(el.textContent);
        if (label.includes('send code') || text.includes('send code')) continue;
        if (!label.includes('close') && !label.includes('dismiss')) continue;
        const elRect = el.getBoundingClientRect();
        labeledClose = {
          x: elRect.left + (elRect.width / 2),
          y: elRect.top + (elRect.height / 2),
          label: label || text || 'close',
        };
        break;
      }

      return {
        dialogBox: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          top: rect.top,
        },
        svgClose,
        labeledClose,
      };
    });

    if (dialogState?.svgClose) {
      console.log(`[inbox-monitor] Clicking dialog SVG close at (${Math.round(dialogState.svgClose.x)}, ${Math.round(dialogState.svgClose.y)})`);
      await this.page.mouse.click(dialogState.svgClose.x, dialogState.svgClose.y);
      await new Promise(r => setTimeout(r, 1500));

      gone = await this.page.evaluate(() => {
        const body = (document.body?.textContent || '').toLowerCase();
        return !body.includes('restore your chat history') && !body.includes('one-time code');
      });
      if (gone) {
        console.log('[inbox-monitor] Dialog dismissed via SVG close');
        return;
      }
    }

    if (dialogState?.labeledClose) {
      console.log(`[inbox-monitor] Clicking dialog labeled control: ${dialogState.labeledClose.label}`);
      await this.page.mouse.click(dialogState.labeledClose.x, dialogState.labeledClose.y);
      await new Promise(r => setTimeout(r, 1500));

      gone = await this.page.evaluate(() => {
        const body = (document.body?.textContent || '').toLowerCase();
        return !body.includes('restore your chat history') && !body.includes('one-time code');
      });
      if (gone) {
        console.log('[inbox-monitor] Dialog dismissed via labeled close');
        return;
      }
    }

    if (dialogState?.dialogBox) {
      const xBtnX = dialogState.dialogBox.right - 30;
      const xBtnY = dialogState.dialogBox.top + 30;
      console.log(`[inbox-monitor] Clicking dialog X at (${Math.round(xBtnX)}, ${Math.round(xBtnY)})`);
      await this.page.mouse.click(xBtnX, xBtnY);
      await new Promise(r => setTimeout(r, 1500));

      gone = await this.page.evaluate(() => {
        const body = (document.body?.textContent || '').toLowerCase();
        return !body.includes('restore your chat history') && !body.includes('one-time code');
      });
      if (gone) {
        console.log('[inbox-monitor] Dialog dismissed via X click');
        return;
      }
    }

    console.log('[inbox-monitor] Clicking outside dialog to dismiss...');
    await this.page.mouse.click(50, 400);
    await new Promise(r => setTimeout(r, 1000));

    gone = await this.page.evaluate(() => {
      const body = (document.body?.textContent || '').toLowerCase();
      return !body.includes('restore your chat history') && !body.includes('one-time code');
    });
    if (gone) {
      console.log('[inbox-monitor] Dialog dismissed via backdrop click');
      return;
    }

    console.warn('[inbox-monitor] WARNING: Could not dismiss chat history dialog');
  }

  async _scrollChatToBottom() {
    // FB chat uses virtual scrolling — only visible messages are in the DOM.
    // We need to scroll repeatedly until all messages are loaded.
    // Track the number of [role="row"] elements to detect when new messages load.

    // Log scroll container state for debugging
    const scrollInfo = await this.page.evaluate(() => {
      const containers = [];
      const allDivs = document.querySelectorAll('div');
      for (const div of allDivs) {
        const rect = div.getBoundingClientRect();
        if (rect.x > 350 && rect.height > 200 && div.scrollHeight > div.clientHeight + 50) {
          containers.push({
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height),
            scrollTop: Math.round(div.scrollTop),
            scrollHeight: Math.round(div.scrollHeight),
            clientHeight: Math.round(div.clientHeight),
            atBottom: div.scrollTop + div.clientHeight >= div.scrollHeight - 10,
          });
        }
      }
      return containers;
    });
    console.log(`[inbox-monitor] Scroll containers found: ${scrollInfo.length}`);
    for (const c of scrollInfo) {
      console.log(`[inbox-monitor]   container: x=${c.x} y=${c.y} ${c.w}x${c.h} scroll=${c.scrollTop}/${c.scrollHeight} client=${c.clientHeight} atBottom=${c.atBottom}`);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const prevRowCount = await this.page.evaluate(() => {
        return document.querySelectorAll('[role="row"]').length;
      });

      await this.page.evaluate(() => {
        // Find and scroll all potential chat containers
        const allDivs = document.querySelectorAll('div');
        for (const div of allDivs) {
          const rect = div.getBoundingClientRect();
          // Chat panel: right side (x > 350), tall enough, has scroll overflow
          if (rect.x > 350 && rect.height > 200 && div.scrollHeight > div.clientHeight + 50) {
            div.scrollTop = div.scrollHeight;
          }
        }
      });

      await new Promise(r => setTimeout(r, 1500));

      const newRowCount = await this.page.evaluate(() => {
        return document.querySelectorAll('[role="row"]').length;
      });

      // If no new rows appeared after scrolling, we've loaded everything
      if (newRowCount <= prevRowCount) {
        console.log(`[inbox-monitor] Chat scrolled to bottom (${newRowCount} rows after ${attempt + 1} scroll(s))`);
        break;
      }

      console.log(`[inbox-monitor] Chat scroll pass ${attempt + 1}: ${prevRowCount} → ${newRowCount} rows, scrolling again...`);
    }
  }

  /**
   * Extract conversation threads from the Marketplace inbox.
   *
   * FB Marketplace inbox (2026) shows conversation rows as div[role="button"]
   * with text format: "BuyerName · ListingTitle MessagePreview Timestamp"
   * The rows contain an image (listing photo), buyer name, listing title,
   * last message preview, and timestamp.
   *
   * @returns {Array<{threadId: string, buyerName: string, lastMessage: string, listingTitle: string, unread: boolean, timestamp: string, _index: number}>}
   */
  async getUnreadThreads() {
    console.log(`[inbox-monitor] Scanning for conversations (${this._usingMessenger ? 'Messenger' : 'Marketplace'} mode)...`);

    await humanDelay(1000, 2000);

    // If we fell back to Messenger, use Messenger-specific extraction
    if (this._usingMessenger) {
      return this._getMessengerThreads();
    }

    {
      if (this._graphqlThreads.length > 0) {
        const threads = this._graphqlThreads.map((thread, index) => {
          const buyerName = (thread.buyerName || '').trim() || 'Unknown';
          const unknownBuyer = !thread.buyerName || /^unknown$/i.test((thread.buyerName || '').trim());

          return {
            threadId: thread.threadId || this._buildSyntheticThreadId(buyerName, thread.listingTitle, thread.realThreadId),
            buyerName,
            listingTitle: thread.listingTitle || '',
            lastMessage: thread.lastMessage || '',
            unread: typeof thread.unread === 'boolean' ? thread.unread : true,
            timestamp: thread.timestamp || '',
            _realFbId: thread.realThreadId || thread._realFbId || '',
            _index: index,
            _unknownBuyer: unknownBuyer,
          };
        });

        console.log(`[inbox-monitor] Found ${threads.length} conversation(s) from GraphQL`);
        return threads;
      }

      const threads = await this._getMarketplaceThreadsFromDom();
      const withUnread = threads.map(t => ({ ...t, unread: true }));

      console.log(`[inbox-monitor] Found ${withUnread.length} conversation(s)`);
      return withUnread;
    }

    const threads = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Strategy: find div[role="button"] elements that contain conversation data
      // Conversation rows contain a middle-dot separator (· U+00B7 or similar)
      const buttons = document.querySelectorAll('div[role="button"]');

      // Match various middle dot characters FB may use
      const DOT_CHARS = ['·', '\u00B7', '\u2022', '\u2027', '\u22C5'];
      function findDot(text) {
        for (const d of DOT_CHARS) {
          if (text.includes(d)) return d;
        }
        return null;
      }

      for (const btn of buttons) {
        if (btn.offsetParent === null) continue;
        const rect = btn.getBoundingClientRect();

        // Conversation rows are in the main content area — skip sidebar (x < 250)
        // and skip very small elements
        if (rect.x < 250 || rect.y < 80 || rect.width < 150 || rect.height < 40) continue;

        const fullText = btn.textContent?.trim() || '';
        if (!fullText || fullText.length < 5) continue;

        // Must contain a dot separator between buyer name and listing title
        const dot = findDot(fullText);
        if (!dot) continue;

        // Skip elements that look like listing cards (contain "$" price)
        if (/\$[\d,]+/.test(fullText)) continue;

        // Deduplicate (nested divs repeat the same text)
        const key = fullText.substring(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);

        // Parse: "BuyerName  · ListingTitle MessagePreview Timestamp"
        const parts = fullText.split(dot).map(s => s.trim());
        const buyerName = parts[0] || 'Unknown';

        // The rest contains listing title, message, and timestamp
        // Get individual spans for more precise parsing
        const spans = btn.querySelectorAll('span');
        const spanTexts = [];
        for (const span of spans) {
          const t = span.textContent?.trim();
          if (t && t.length > 0 && t.length < 200 && !spanTexts.includes(t)) {
            spanTexts.push(t);
          }
        }

        // Listing title is typically the first span after buyer name that isn't a timestamp
        let listingTitle = '';
        let lastMessage = '';
        let timestamp = '';

        // Look for timestamp pattern (HH:MM or "Xd" or "Xh" etc.)
        const timePattern = /^\d{1,2}:\d{2}$|^\d+[dhm]$/;
        for (const st of spanTexts) {
          if (timePattern.test(st)) {
            timestamp = st;
          }
        }

        if (parts.length > 1) {
          // After the "·", the text is "ListingTitle MessagePreview Timestamp"
          const afterDot = parts.slice(1).join('·').trim();
          // Remove timestamp from end if present
          const withoutTime = timestamp ? afterDot.replace(timestamp, '').trim() : afterDot;

          // Strategy 1: Check spans for a clean listing title (FB puts title in a separate span)
          for (const st of spanTexts) {
            if (st === buyerName || st === timestamp) continue;
            if (/^\d{4}\s+[A-Z]/.test(st) && st.length < 60 && st.length > 6) {
              listingTitle = st;
              break;
            }
          }

          if (listingTitle) {
            // We got a clean listing title from spans — extract last message
            const titleIdx = withoutTime.indexOf(listingTitle);
            if (titleIdx >= 0) {
              lastMessage = withoutTime.substring(titleIdx + listingTitle.length).trim();
            }
            if (!lastMessage) lastMessage = withoutTime;
          } else {
            // Strategy 2: Parse concatenated text.
            // FB concatenates listing title + message: "2021 Honda AccordIs this still available?"
            // Split at lowercase→uppercase boundary after a vehicle pattern
            const camelSplit = withoutTime.match(/^(.+?[a-z0-9])([A-Z][a-z].*)$/);
            if (camelSplit) {
              listingTitle = camelSplit[1].trim();
              lastMessage = camelSplit[2].trim();
            } else {
              listingTitle = withoutTime;
              lastMessage = withoutTime;
            }
          }
        }

        // Check for unread: bold text, strong elements, or blue dot
        const hasUnread = btn.querySelector('strong') !== null
          || (() => {
            for (const span of spans) {
              const fw = window.getComputedStyle(span).fontWeight;
              if (parseInt(fw) >= 600 || fw === 'bold') return true;
            }
            return false;
          })();

        // Clean listing title: FB concatenates preview text without a separator.
        // e.g. "2024 BMW 2 Series9am" or "2025 Mazda CX-30919-737-0025"
        // Strategy: insert spaces at concatenation boundaries, then filter words.
        let cleanTitle = listingTitle;
        if (cleanTitle) {
          let s = cleanTitle;
          // digit→uppercase: "30Romeo" → "30 Romeo", "50Yes" → "50 Yes"
          s = s.replace(/(\d)([A-Z])/g, '$1 $2');
          // 2+ lowercase→uppercase: "TellurideIs" → "Telluride Is" (but not "xDrive")
          s = s.replace(/([a-z]{2,})([A-Z])/g, '$1 $2');
          // lowercase→digit: "Series9am" → "Series 9am" (but CX-30 has hyphen not lowercase before digit)
          s = s.replace(/([a-z])(\d)/g, '$1 $2');
          // Split embedded phone: "30919-737-0025" → "30 919-737-0025"
          s = s.replace(/(\d{1,2})(\d{3}[-.]?\d{3}[-.]?\d{4})/, '$1 $2');

          const words = s.split(/\s+/);
          const titleWords = [];
          let pastYear = false;
          for (const w of words) {
            if (!pastYear && /^\d{4}$/.test(w)) { pastYear = true; titleWords.push(w); continue; }
            if (!pastYear) continue;
            if (/@/.test(w)) break;
            if (w.includes('.')) break; // dots = non-vehicle (email fragments, etc)
            if (/^\d{3,}[-.]?\d{3}/.test(w)) break;
            if (/^\d{1,2}(am|pm)$/i.test(w)) break;
            if (/^\d{1,2}:\d{2}$/.test(w)) break;
            if (/[,!?;]/.test(w)) break;
            // Common preview starters (case-insensitive)
            const lw = w.toLowerCase().replace(/[^a-z]/g, '');
            if (lw.length <= 1) break; // single-letter words like "I", "a" are never part of a vehicle title
            if (['is','yes','no','hi','hey','thanks','thank','sure','ok','okay',
                 'waiting','available','still','this','the','we','it','im','lets',
                 'have','got','do','can','will','would','could','want','need',
                 'how','what','when','where','why','my','me','you','your',
                 'finance','financing','trade','cash','down','payment',
                 'mon','tue','wed','thu','fri','sat','sun'].includes(lw)) break;
            titleWords.push(w);
          }
          if (titleWords.length >= 2) cleanTitle = titleWords.join(' ');
        }

        // Include listing title so each buyer/listing pair maps to its own FB thread.
        const buyerSlug = buyerName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
        const listingSlug = cleanTitle
          ? '_' + cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '').substring(0, 50)
          : '';
        const threadId = 'inbox_' + buyerSlug + listingSlug;

        results.push({
          threadId,
          buyerName,
          lastMessage,
          listingTitle,
          unread: hasUnread,
          timestamp,
          _index: results.length
        });
      }

      return results;
    });

    // Mark all as unread for now (FB doesn't reliably expose read state in this view)
    // The orchestrator's inbox-state.json handles dedup
    const withUnread = threads.map(t => ({ ...t, unread: true }));

    console.log(`[inbox-monitor] Found ${withUnread.length} conversation(s)`);
    return withUnread;
  }

  /**
   * Get marketplace threads from intercepted GraphQL data.
   * No DOM scanning - uses structured JSON from FB's own API responses.
   */
  async getThreadsFromGraphQL() {
    console.log('[inbox-monitor] Getting threads from GraphQL data...');

    // Wait a moment for GraphQL responses to be intercepted
    await humanDelay(2000, 3000);

    const threads = this._graphqlThreads.map((thread, index) => ({
      threadId: thread.threadId || this._buildSyntheticThreadId(thread.buyerName, thread.listingTitle, thread.realThreadId),
      buyerName: thread.buyerName || 'Unknown',
      listingTitle: thread.listingTitle || '',
      lastMessage: thread.lastMessage || '',
      unread: thread.unread,
      timestamp: thread.timestamp || '',
      realThreadId: thread.realThreadId || '',
      _realFbId: thread.realThreadId || '',
      _realFbUrl: thread.realThreadId ? `https://www.facebook.com/messages/t/${thread.realThreadId}` : '',
      _index: index,
    }));

    console.log(`[inbox-monitor] Found ${threads.length} thread(s) from GraphQL`);
    for (const t of threads) {
      console.log(`[inbox-monitor]   ${t.buyerName} - ${t.listingTitle || 'no title'} [id:${t.realThreadId || 'none'}]`);
    }
    return threads;
  }

  /**
   * Get only threads for ACTIVE listings (ones with a listing photo).
   * Active listing rows have an <img> element (the listing photo).
   * Old/inactive rows have an SVG chat icon instead -- no <img>.
   */
  async _getActiveListingThreadsFromDom() {
    console.log('[inbox-monitor] Scanning for ACTIVE listing threads only...');
    await humanDelay(1000, 2000);

    if (this._usingMessenger) {
      return this._getMessengerThreads();
    }

    const rows = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const DOT_CHARS = ['\u00B7', '\u2022', '\u2027', '\u22C5'];

      for (const btn of document.querySelectorAll('div[role="button"]')) {
        if (btn.offsetParent === null) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.x < 250 || rect.y < 80 || rect.width < 150 || rect.height < 40) continue;

        const fullText = btn.textContent?.trim() || '';
        if (!fullText || fullText.length < 5) continue;
        if (/\$[\d,]+/.test(fullText)) continue;

        const dot = DOT_CHARS.find(d => fullText.includes(d));
        if (!dot) continue;

        const key = fullText.substring(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);

        const parts = fullText.split(dot).map(s => s.trim());
        const buyerName = parts[0] || 'Unknown';
        const afterDot = parts.slice(1).join(' ').trim();

        const spans = btn.querySelectorAll('span');
        let listingTitle = '';
        for (const span of spans) {
          const text = span.textContent?.trim();
          if (!text || text === buyerName) continue;
          if (/^\d{4}\s+\w/.test(text) && text.length < 60 && text.length > 6) {
            listingTitle = text;
            break;
          }
        }
        if (!listingTitle) listingTitle = afterDot;

        // Clean listing title: FB concatenates title with preview text without spaces
        // e.g. "2018 Ford FiestaClay Newsome sent you..." or "2019 Toyota CorollaYou left"
        // Split at camelCase boundaries then take first 3 words (Year Make Model)
        if (listingTitle) {
          const spaced = listingTitle
            .replace(/([a-z])([A-Z])/g, '$1 $2')   // "FiestaClay" → "Fiesta Clay"
            .replace(/(\d)([A-Z])/g, '$1 $2')       // "30Clay" → "30 Clay"
            .replace(/(\d)([a-z])/g, '$1 $2');       // "XC90joseph" → "XC90 joseph"
          const words = spaced.split(/\s+/);
          if (words.length >= 3 && /^\d{4}$/.test(words[0])) {
            // Take Year Make Model, strip junk from model: "Fiesta?9:08" → "Fiesta"
            const model = words[2].replace(/[^a-zA-Z0-9-].*$/, '');
            listingTitle = words[0] + ' ' + words[1] + ' ' + model;
          }
        }

        // Detect unread: FB bolds the text for threads with new messages
        const hasUnread = btn.querySelector('strong') !== null
          || Array.from(btn.querySelectorAll('span')).some(span => {
            const fw = window.getComputedStyle(span).fontWeight;
            return parseInt(fw) >= 600 || fw === 'bold';
          });

        const boldCount = Array.from(btn.querySelectorAll('span')).filter(span => {
          const fw = window.getComputedStyle(span).fontWeight;
          return parseInt(fw) >= 600 || fw === 'bold';
        }).length;

        results.push({
          buyerName,
          listingTitle,
          unread: hasUnread,
          boldCount,
          _index: results.length,
        });
      }

      return results;
    });

    const threads = rows.map((row, index) => ({
      threadId: this._buildSyntheticThreadId(row.buyerName, row.listingTitle),
      buyerName: row.buyerName || 'Unknown',
      listingTitle: row.listingTitle || '',
      lastMessage: '',
      unread: row.unread,
      timestamp: '',
      _index: typeof row._index === 'number' ? row._index : index,
    }));

    for (const thread of threads) {
      const gqlMatch = this._graphqlThreads.find(g => {
        const normGql = this._normalizeText(g.buyerName);
        const normThread = this._normalizeText(thread.buyerName);
        return normGql === normThread || normGql.startsWith(normThread) || normThread.startsWith(normGql);
      });
      if (gqlMatch && gqlMatch.realThreadId) {
        thread._realFbId = gqlMatch.realThreadId;
        thread._realFbUrl = `https://www.facebook.com/marketplace/inbox/?thread_id=${gqlMatch.realThreadId}`;
      }
    }

    console.log(`[inbox-monitor] Found ${threads.length} ACTIVE listing thread(s)`);
    for (const thread of threads) {
      console.log(`[inbox-monitor]   ${thread.buyerName} -- ${thread.listingTitle} [bold:${thread.boldCount || 0} unread:${thread.unread}]`);
    }
    return threads;
  }

  async _getMarketplaceThreadsFromDom() {
    const rows = await this.page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const DOT_CHARS = ['\u00B7', '\u2022', '\u2027', '\u22C5'];
      const TIMESTAMP_PATTERNS = [
        /^\d{1,2}:\d{2}$/,
        /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
        /^\d{1,2}:\d{2}\s*(AM|PM)/i,
        /^\d+[smhdw]$/i,
        /^(today|yesterday)$/i,
        /^(today|yesterday)\s+at\s+/i,
        /^(mon|tue|wed|thu|fri|sat|sun)$/i,
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i,
        /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/,
      ];

      const normalize = (text) => (text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isTimestamp = (text) => TIMESTAMP_PATTERNS.some((pattern) => pattern.test((text || '').trim()));
      const findDot = (text) => DOT_CHARS.find(dot => (text || '').includes(dot)) || null;

      function collectSegments(button) {
        const collected = [];
        const nodes = button.querySelectorAll('span, strong, a, div[dir="auto"]');

        for (const node of nodes) {
          if (node.offsetParent === null) continue;
          const text = node.textContent?.trim();
          if (!text || text.length > 180) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 6 || rect.height < 6) continue;
          collected.push({ text, y: rect.y, x: rect.x });
        }

        const lines = (button.innerText || '')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map((text, idx) => ({ text, y: 1000 + idx, x: idx }));

        const ordered = collected.concat(lines).sort((a, b) => a.y - b.y || a.x - b.x);
        const unique = [];
        const uniqueKeys = new Set();

        for (const item of ordered) {
          const key = normalize(item.text);
          if (!key || uniqueKeys.has(key)) continue;
          uniqueKeys.add(key);
          unique.push(item.text);
        }

        return unique;
      }

      function parseRow(button) {
        const rect = button.getBoundingClientRect();
        if (rect.x <= 250 || rect.y <= 80 || rect.width <= 150 || rect.height <= 40) return null;

        const fullText = button.textContent?.trim() || '';
        if (!fullText || fullText.length < 5) return null;
        if (/\$[\d,]+/.test(fullText)) return null;

        const segments = collectSegments(button);
        if (segments.length < 2) return null;

        const timestamp = segments.find(isTimestamp) || '';
        if (!timestamp) return null;

        const contentSegments = segments.filter(text => !isTimestamp(text));
        if (contentSegments.length < 2) return null;

        const headerSegment = contentSegments.find(text => findDot(text))
          || (findDot(fullText) ? (button.innerText || fullText).split('\n')[0].trim() : '');
        let buyerName = contentSegments[0];
        let listingTitle = '';

        if (headerSegment) {
          const dot = findDot(headerSegment);
          const parts = dot
            ? headerSegment.split(dot).map(part => part.trim()).filter(Boolean)
            : [];
          if (parts.length >= 2) {
            buyerName = parts[0];
            listingTitle = parts.slice(1).join(' ').trim();
          }
        }

        const lastMessage = contentSegments.find(text => {
          if (text === buyerName) return false;
          if (text === listingTitle) return false;
          if (text === headerSegment) return false;
          return true;
        }) || contentSegments[1] || '';

        if (!buyerName || !lastMessage) return null;

        return {
          buyerName,
          listingTitle,
          lastMessage,
          timestamp,
        };
      }

      for (const button of document.querySelectorAll('div[role="button"], a[role="link"], a[href*="marketplace"], div[role="row"], div[role="listitem"]')) {
        if (button.offsetParent === null) continue;

        const parsed = parseRow(button);
        if (!parsed) continue;

        const key = normalize(`${parsed.buyerName}|${parsed.listingTitle}|${parsed.lastMessage}|${parsed.timestamp}`);
        if (!key || seen.has(key)) continue;
        seen.add(key);

        results.push({
          buyerName: parsed.buyerName,
          listingTitle: parsed.listingTitle,
          lastMessage: parsed.lastMessage,
          timestamp: parsed.timestamp,
          _index: results.length,
        });
      }

      return results;
    });

    return rows.map((row, index) => ({
      threadId: this._buildSyntheticThreadId(row.buyerName, row.listingTitle),
      buyerName: row.buyerName || 'Unknown',
      listingTitle: row.listingTitle || '',
      lastMessage: row.lastMessage || '',
      unread: true,
      timestamp: row.timestamp || '',
      _index: typeof row._index === 'number' ? row._index : index,
    }));
  }

  /**
   * Extract Marketplace conversation threads from Facebook Messenger.
   *
   * After clicking the "Marketplace" entry in Messenger sidebar, the right
   * panel shows the most recent Marketplace conversation with header:
   * "BuyerName · ListingTitle". The Marketplace group in Messenger doesn't
   * show individual threads in the sidebar — it groups them all under one entry.
   *
   * Strategy: Read the currently visible Marketplace conversation from the
   * right panel header. This gives us the active thread. On subsequent polls,
   * FB may show different threads as new messages arrive.
   */
  async _getMessengerThreads() {
    await this.takeScreenshot('messenger_threads_scan');

    const results = [];

    // Extract info from the currently visible Marketplace conversation header.
    // The header shows "BuyerName · ListingTitle" (with middle dot separator).
    const visibleThread = await this.page.evaluate(() => {
      const DOT_CHARS = ['·', '\u00B7', '\u2022', '\u2027'];

      // Look for the header area in the right/main panel
      // Marketplace chat header: "Romeo · 2025 Mazda CX-30"
      const allSpans = document.querySelectorAll('span, a, h2, [role="heading"]');

      for (const el of allSpans) {
        const rect = el.getBoundingClientRect();
        // Header is in the right panel (x > 350), near the top (y < 150)
        if (rect.x < 350 || rect.y > 150 || rect.y < 50) continue;

        const text = el.textContent?.trim() || '';
        if (!text || text.length < 5 || text.length > 120) continue;

        // Check for "BuyerName · ListingTitle" pattern
        let dot = null;
        for (const d of DOT_CHARS) {
          if (text.includes(d)) { dot = d; break; }
        }

        if (dot) {
          const parts = text.split(dot).map(s => s.trim());
          if (parts.length >= 2 && parts[0].length >= 2) {
            return {
              buyerName: parts[0],
              listingTitle: parts.slice(1).join(' ').trim(),
            };
          }
        }
      }

      // Fallback: look for vehicle listing text separately
      let buyerName = '';
      let listingTitle = '';

      for (const el of allSpans) {
        const rect = el.getBoundingClientRect();
        if (rect.x < 350 || rect.y > 180 || rect.y < 50) continue;

        const text = el.textContent?.trim() || '';
        if (!text || text.length < 2 || text.length > 80) continue;

        // Vehicle pattern
        const vMatch = text.match(/\b(19\d{2}|20[0-3]\d)\s+\w+\s+\w+/);
        if (vMatch && !listingTitle) {
          listingTitle = text;
          continue;
        }

        // Price pattern — skip but note we're in Marketplace context
        if (/^\$[\d,]+/.test(text)) continue;

        // Buyer name: short text, not a UI element
        if (!buyerName && text.length > 2 && text.length < 40 &&
            !/^(View|More|Send|Reply|Search|Chats)/i.test(text)) {
          buyerName = text;
        }
      }

      if (buyerName) return { buyerName, listingTitle };
      return null;
    });

    if (visibleThread) {
      const buyerSlug = visibleThread.buyerName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
      const listingSlug = visibleThread.listingTitle
        ? '_' + visibleThread.listingTitle.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '').substring(0, 50)
        : '';

      results.push({
        threadId: 'inbox_' + buyerSlug + listingSlug,
        buyerName: visibleThread.buyerName,
        lastMessage: '',
        listingTitle: visibleThread.listingTitle,
        unread: true,
        timestamp: '',
        _index: 0,
        _messengerHref: null,
        _alreadyOpen: true,
      });
      console.log(`[inbox-monitor] Found visible Marketplace chat: ${visibleThread.buyerName} - ${visibleThread.listingTitle}`);
    } else {
      console.warn('[inbox-monitor] Could not identify visible Marketplace conversation from header');
    }

    console.log(`[inbox-monitor] Found ${results.length} Marketplace conversation(s) via Messenger`);
    return results;
  }

  async _clickMarketplaceThreadRow(thread) {
    return this.page.evaluate((target) => {
      const DOT_CHARS = ['\u00B7', '\u2022', '\u2027', '\u22C5'];
      const TIMESTAMP_PATTERNS = [
        /^\d{1,2}:\d{2}$/,
        /^\d{1,2}:\d{2}\s*(AM|PM)$/i,
        /^\d{1,2}:\d{2}\s*(AM|PM)/i,
        /^\d+[smhdw]$/i,
        /^(today|yesterday)$/i,
        /^(today|yesterday)\s+at\s+/i,
        /^(mon|tue|wed|thu|fri|sat|sun)$/i,
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i,
        /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/,
      ];

      const normalize = (text) => (text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      const isTimestamp = (text) => TIMESTAMP_PATTERNS.some((pattern) => pattern.test((text || '').trim()));
      const findDot = (text) => DOT_CHARS.find(dot => (text || '').includes(dot)) || null;

      function collectSegments(button) {
        const collected = [];
        const nodes = button.querySelectorAll('span, strong, a, div[dir="auto"]');

        for (const node of nodes) {
          if (node.offsetParent === null) continue;
          const text = node.textContent?.trim();
          if (!text || text.length > 180) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width < 6 || rect.height < 6) continue;
          collected.push({ text, y: rect.y, x: rect.x });
        }

        const lines = (button.innerText || '')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean)
          .map((text, idx) => ({ text, y: 1000 + idx, x: idx }));

        const ordered = collected.concat(lines).sort((a, b) => a.y - b.y || a.x - b.x);
        const unique = [];
        const uniqueKeys = new Set();

        for (const item of ordered) {
          const key = normalize(item.text);
          if (!key || uniqueKeys.has(key)) continue;
          uniqueKeys.add(key);
          unique.push(item.text);
        }

        return unique;
      }

      function parseRow(button) {
        const rect = button.getBoundingClientRect();
        if (rect.x <= 250 || rect.y <= 80 || rect.width <= 150 || rect.height <= 40) return null;

        const fullText = button.textContent?.trim() || '';
        if (!fullText || fullText.length < 5) return null;
        if (/\$[\d,]+/.test(fullText)) return null;

        const segments = collectSegments(button);
        if (segments.length < 2) return null;

        const timestamp = segments.find(isTimestamp) || '';
        if (!timestamp) return null;

        const contentSegments = segments.filter(text => !isTimestamp(text));
        if (contentSegments.length < 2) return null;

        const headerSegment = contentSegments.find(text => findDot(text))
          || (findDot(fullText) ? (button.innerText || fullText).split('\n')[0].trim() : '');
        let buyerName = contentSegments[0];
        let listingTitle = '';

        if (headerSegment) {
          const dot = findDot(headerSegment);
          const parts = dot
            ? headerSegment.split(dot).map(part => part.trim()).filter(Boolean)
            : [];
          if (parts.length >= 2) {
            buyerName = parts[0];
            listingTitle = parts.slice(1).join(' ').trim();
          }
        }

        const lastMessage = contentSegments.find(text => {
          if (text === buyerName) return false;
          if (text === listingTitle) return false;
          if (text === headerSegment) return false;
          return true;
        }) || contentSegments[1] || '';

        if (!buyerName || !lastMessage) return null;

        return {
          buyerName,
          listingTitle,
          lastMessage,
          fullText,
          hasDotSeparator: Boolean(findDot(headerSegment) || findDot(fullText)),
        };
      }

      const wantedListing = normalize(target.listingTitle).substring(0, 40);
      const wantedMessage = normalize(target.lastMessage).substring(0, 40);
      const unknownBuyer = Boolean(target._unknownBuyer) || normalize(target.buyerName) === 'unknown';
      const matchByListingOnly = Boolean(unknownBuyer && wantedListing);

      let best = null;
      for (const button of document.querySelectorAll('div[role="button"], a[role="link"], a[href*="marketplace"], div[role="row"], div[role="listitem"]')) {
        if (button.offsetParent === null) continue;

        const parsed = parseRow(button);
        if (!parsed) continue;
        const normFullText = normalize(parsed.fullText);

        if (matchByListingOnly) {
          if (!normFullText.includes(wantedListing)) continue;
        } else {
          // Flexible name match: GraphQL gives full names ("Romeo Lassiter")
          // but DOM may show just first name ("Romeo"). Match if either starts with the other.
          const normParsed = normalize(parsed.buyerName);
          const normTarget = normalize(target.buyerName);
          if (!normParsed.startsWith(normTarget) && !normTarget.startsWith(normParsed) && !normParsed.includes(normTarget) && !normTarget.includes(normParsed)) continue;
        }

        let score = 100;

        if (wantedListing) {
          const listingMatch = normalize(parsed.listingTitle).includes(wantedListing) || normFullText.includes(wantedListing);
          if (listingMatch) {
            score += 200;
          } else if (!parsed.hasDotSeparator) {
            score -= 50;
          }
        }

        if (wantedMessage && normalize(parsed.lastMessage).includes(wantedMessage)) {
          score += 15;
        }

        if (parsed.listingTitle) score += 2;

        if (!best || score > best.score) {
          best = {
            score,
            label: parsed.fullText.substring(0, 80),
            button,
          };
        }
      }

      if (!best) return null;

      best.button.click();
      return best.label;
    }, {
      buyerName: thread.buyerName || '',
      listingTitle: thread.listingTitle || '',
      lastMessage: thread.lastMessage || '',
      _unknownBuyer: Boolean(thread._unknownBuyer),
    });
  }

  /**
   * Click an active listing row by matching listing title + buyer name.
   * Only targets div[role="button"] elements with <img> inside (active listings).
   */
  async _clickActiveListingRow(thread) {
    return this.page.evaluate((target) => {
      const normalize = (text) => (text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const wantedBuyer = normalize(target.buyerName);
      const wantedListing = normalize(target.listingTitle);

      for (const btn of document.querySelectorAll('div[role="button"]')) {
        if (btn.offsetParent === null) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.x < 250 || rect.y < 80 || rect.width < 150 || rect.height < 40) continue;

        const fullText = btn.textContent?.trim() || '';
        const normFull = normalize(fullText);

        if (wantedListing && normFull.includes(wantedListing.substring(0, 20))) {
          btn.click();
          return fullText.substring(0, 80);
        }

        if (wantedBuyer && normFull.includes(wantedBuyer)) {
          btn.click();
          return fullText.substring(0, 80);
        }
      }

      return null;
    }, {
      buyerName: thread.buyerName || '',
      listingTitle: thread.listingTitle || '',
    });
  }

  async _extractActiveThreadHeader() {
    return this.page.evaluate(() => {
      const DOT_CHARS = ['\u00B7', '\u2022', '\u2027', '\u22C5'];
      const candidates = [];

      for (const el of document.querySelectorAll('[role="heading"], h2, h3, span, a')) {
        if (el.offsetParent === null) continue;
        const rect = el.getBoundingClientRect();
        if (rect.x < 350 || rect.y < 0 || rect.y > 200) continue;

        const text = el.textContent?.trim() || '';
        if (!text || text.length < 2 || text.length > 180) continue;

        candidates.push({ text, x: rect.x, y: rect.y });
      }

      candidates.sort((a, b) => a.y - b.y || a.x - b.x);

      for (const candidate of candidates) {
        const dot = DOT_CHARS.find(char => candidate.text.includes(char));
        if (!dot) continue;

        const parts = candidate.text.split(dot).map(part => part.trim()).filter(Boolean);
        if (parts.length >= 2) {
          return {
            headerText: candidate.text,
            buyerName: parts[0],
            listingTitle: parts.slice(1).join(' ').trim(),
          };
        }
      }

      const fallback = candidates.find(candidate => !/^(view|more|search|marketplace|chats)$/i.test(candidate.text));
      return fallback ? {
        headerText: fallback.text,
        buyerName: fallback.text,
        listingTitle: '',
      } : {
        headerText: '',
        buyerName: '',
        listingTitle: '',
      };
    });
  }

  async _captureActiveThreadUrl(thread) {
    const info = await this.page.evaluate(() => {
      const hrefs = [];
      const seen = new Set();
      const pushHref = (href) => {
        if (!href) return;
        try {
          const absolute = href.startsWith('http') ? href : new URL(href, window.location.origin).toString();
          if (!seen.has(absolute)) {
            seen.add(absolute);
            hrefs.push(absolute);
          }
        } catch {
          // ignore malformed urls
        }
      };

      pushHref(window.location.href);

      for (const link of document.querySelectorAll('a[href*="thread_id="], a[href*="/messages/t/"], a[href*="thread_fbid="]')) {
        const href = link.getAttribute('href') || link.href;
        pushHref(href);
      }

      for (const href of hrefs) {
        const match = href.match(/[?&]thread_id=(\d{6,})/i)
          || href.match(/\/messages\/t\/(\d{6,})/i)
          || href.match(/[?&](?:id|thread_fbid)=(\d{6,})/i)
          || href.match(/\/(\d{6,})(?:[/?#]|$)/);
        if (match) {
          return { url: href, realThreadId: match[1] };
        }
      }

      return null;
    });

    const realThreadId = info?.realThreadId || thread._realFbId || '';
    const realThreadUrl = info?.url || (realThreadId
      ? `https://www.facebook.com/marketplace/inbox/?thread_id=${realThreadId}`
      : '');

    if (realThreadId) {
      thread._realFbId = realThreadId;
    }
    if (realThreadUrl) {
      thread._realFbUrl = realThreadUrl;
    }
  }

  /**
   * Open a conversation thread by clicking its row in the inbox.
   * The chat panel opens on the right side (URL stays the same).
   * Extracts the full message history from the chat panel.
   *
   * FB Marketplace (2026) chat panel uses [role="row"] elements for messages.
   * Each row's text is prefixed with the sender name: "BuyerNameMessageText"
   * System messages (quick responses, "started this chat") are also [role="row"].
   *
   * @param {object} thread - Thread from getUnreadThreads()
   * @returns {Array<{sender: string, text: string, timestamp: string, isBuyer: boolean}>}
   */
  async openThread(thread) {
    console.log(`[inbox-monitor] Opening thread: ${thread.buyerName}${thread.listingTitle ? ` - ${thread.listingTitle}` : ''} (${this._usingMessenger ? 'Messenger' : 'Marketplace'} mode)`);

    // --- Messenger mode: click by href or buyer name in sidebar ---
    if (this._usingMessenger) {
      return this._openMessengerThread(thread);
    }

    // Close any existing Marketplace chat panels to prevent stacked panels.
    // Only close CHAT panels (identified by "Close chat" aria-label), NOT
    // Messenger/Notifications overlays which use generic "close" labels.
    const closedPanels = await this.page.evaluate(() => {
      const closed = [];
      // Target specifically "Close chat" buttons (Marketplace chat panels)
      const closeButtons = document.querySelectorAll('[aria-label="Close chat"]');
      for (const btn of closeButtons) {
        if (btn.offsetParent !== null) {
          btn.click();
          closed.push('Close chat');
        }
      }
      return closed;
    });
    if (closedPanels.length > 0) {
      console.log(`[inbox-monitor] Closed ${closedPanels.length} stacked chat panel(s): ${closedPanels.join(', ')}`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Click the conversation row by matching buyer name plus listing/message hints.
    const clicked = await this._clickActiveListingRow(thread);
    if (false) {
      await this.page.evaluate((buyerName, listingTitle) => {
      const DOT_CHARS = ['·', '\u00B7', '\u2022', '\u2027', '\u22C5'];
      function hasDot(text) {
        for (const d of DOT_CHARS) { if (text.includes(d)) return true; }
        return false;
      }

      function normalize(text) {
        return (text || '')
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      }

      const seen = new Set();
      const buttons = document.querySelectorAll('div[role="button"]');

      for (const btn of buttons) {
        if (btn.offsetParent === null) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.x < 250 || rect.y < 80 || rect.width < 150) continue;

        const text = btn.textContent?.trim() || '';
        if (!hasDot(text)) continue;

        // Skip listing cards
        if (/\$[\d,]+/.test(text)) continue;

        const key = text.substring(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);

        const dot = DOT_CHARS.find(d => text.includes(d));
        const namePart = dot ? text.split(dot)[0].trim() : '';
        if (normalize(namePart) !== normalize(buyerName)) continue;

        if (listingTitle) {
          const afterDot = dot ? text.split(dot).slice(1).join(dot).trim() : '';
          if (!normalize(afterDot).includes(normalize(listingTitle).substring(0, 20))) continue;
        }

        btn.click();
        return text.substring(0, 80);
      }
      return null;
      }, thread.buyerName, thread.listingTitle || '');
    }

    if (!clicked) {
      // Fallback: if we have a real FB thread ID, open via Messenger URL
      // which directly loads the conversation (unlike marketplace inbox URLs)
      const realId = thread._realFbId;
      if (realId) {
        const messengerUrl = `https://www.facebook.com/messages/t/${realId}`;
        console.log(`[inbox-monitor] Row click failed — opening via Messenger: ${messengerUrl}`);
        await this.page.goto(messengerUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await humanDelay(3000, 5000);
        await this._dismissMessengerDialogs().catch(() => {});
      } else {
        console.log('[inbox-monitor] Could not click thread row (no fallback URL)');
        return [];
      }
    }

    console.log(`[inbox-monitor] Clicked: ${clicked || 'via fallback'}`);
    // await humanDelay already done in both paths above

    // Dismiss dialogs but do NOT press Escape — that would close the chat panel
    await this.page.evaluate(() => {
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.offsetParent === null) continue;
        for (const btn of dialog.querySelectorAll('[role="button"], button, [aria-label="Close"]')) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
          if (label === 'close' || text === 'close' || text === 'not now' ||
              text === 'skip' || text === 'dismiss' || text === 'got it') {
            btn.click();
            break;
          }
        }
      }
    });
    await new Promise(r => setTimeout(r, 500));

    const header = await this._extractActiveThreadHeader();
    if (header?.listingTitle && !thread.listingTitle) {
      thread.listingTitle = header.listingTitle;
      console.log(`[inbox-monitor] Filled listing title from chat header: ${thread.listingTitle}`);
    }
    if (header?.buyerName && (!thread.buyerName || /^unknown$/i.test(thread.buyerName))) {
      thread.buyerName = header.buyerName;
      console.log(`[inbox-monitor] Updated buyer name from header: ${header.buyerName}`);
    }

    await this._captureActiveThreadUrl(thread);
    if (thread._realFbUrl) {
      console.log(`[inbox-monitor] Captured thread URL: ${thread._realFbUrl}`);
    }

    // Screenshot the opened chat for debugging
    await this.takeScreenshot(`chat_${thread.buyerName}`);

    // Wait for FB to finish loading chat messages (virtual scrolling)
    await humanDelay(3000, 4000);
    await this._scrollChatToBottom();
    // Extra wait + scroll to catch messages FB loads lazily
    await new Promise(r => setTimeout(r, 2000));
    await this._scrollChatToBottom();

    // Extract messages from the chat panel (right side).
    //
    // FB Marketplace chat (2026) structure:
    //   [role="row"] elements contain message rows in the right panel
    //   Each row's textContent is "SenderNameMessageTextEnter"
    //   div[dir="auto"] inside rows contain clean message text
    //
    // Strategy: iterate [role="row"] in the chat panel, skip system rows,
    // extract the clean text from inner div[dir="auto"] elements.
    // Also try div[dir="auto"] directly as a fallback for messages not in rows.
    const messages = await this.page.evaluate((buyerName) => {
      const results = [];
      const debug = [];

      // --- Strategy 1: [role="row"] elements ---
      const rows = document.querySelectorAll('[role="row"]');

      // System/noise phrases to skip (includes FB system messages that appear as [role="row"])
      const SKIP_PHRASES = [
        'started this chat', 'Send a quick response', 'Tap a response',
        'View buyer profile', 'Loading...', 'Beware of', 'common scam',
        'View listing', 'Marketplace',
        // FB system messages that get captured as buyer messages:
        'You can now rate each other',
        'People may rate one another',
        'Rate ' + buyerName,
        'is a buyer on Marketplace',
        'Replying as',
        'typically replies',
        'View buyer\'s profile',
        'joined Facebook in',
        'Lives in',
        'waiting for your response',
        'is waiting for your',
        'sent you a message'
      ];

      // First pass: find all message rows and group by x position.
      // FB can have multiple stacked chat panels — we only want the one
      // for the currently selected buyer thread.
      const rowsByX = {};
      for (const row of rows) {
        if (row.offsetParent === null) continue;
        const rect = row.getBoundingClientRect();
        if (rect.x < 400) continue; // Must be in chat area, not thread list
        const xBucket = Math.round(rect.x / 50) * 50; // Group into 50px buckets
        if (!rowsByX[xBucket]) rowsByX[xBucket] = [];
        rowsByX[xBucket].push(row);
      }

      // Pick the x bucket that has messages containing the buyer name.
      // If multiple, pick the one where the buyer name appears most.
      let targetX = null;
      let bestCount = 0;
      for (const [x, xRows] of Object.entries(rowsByX)) {
        const buyerCount = xRows.filter(r =>
          r.textContent?.trim().startsWith(buyerName)
        ).length;
        if (buyerCount > bestCount) {
          bestCount = buyerCount;
          targetX = parseInt(x);
        }
      }

      debug.push(`x-buckets: ${Object.keys(rowsByX).join(',')} targetX=${targetX} buyerHits=${bestCount}`);

      for (const row of rows) {
        if (row.offsetParent === null) continue;
        const rect = row.getBoundingClientRect();

        // Only extract from the target chat panel
        if (targetX !== null) {
          const rowBucket = Math.round(rect.x / 50) * 50;
          if (rowBucket !== targetX) continue;
        } else if (rect.x < 400) {
          continue;
        }

        const fullText = row.textContent?.trim() || '';
        if (!fullText || fullText.length < 2) { debug.push(`SKIP empty: x=${Math.round(rect.x)}`); continue; }

        // Skip the header row (contains "·" separator)
        if (fullText.includes('·') || fullText.includes('\u00B7')) { debug.push(`SKIP dot: "${fullText.substring(0,80)}"`); continue; }

        // Skip system/noise rows
        let isNoise = false;
        let noisePhrase = '';
        for (const phrase of SKIP_PHRASES) {
          if (fullText.includes(phrase)) { isNoise = true; noisePhrase = phrase; break; }
        }
        if (isNoise) { debug.push(`SKIP noise[${noisePhrase}]: "${fullText.substring(0,80)}"`); continue; }

        // Determine sender:
        // "You sent" prefix = our message
        // BuyerName prefix = buyer message
        // Neither = could still be buyer (FB sometimes omits the name prefix)
        const isSentByUs = fullText.startsWith('You sent');
        const isBuyerByName = fullText.startsWith(buyerName);

        // Primary strategy: use the row's innerText which captures full concatenated content
        // then strip the sender prefix. This avoids fragment issues with nested div[dir="auto"].
        const rowInnerText = row.innerText?.trim() || '';
        let cleanText = '';

        if (rowInnerText) {
          cleanText = rowInnerText;
          if (isSentByUs) {
            cleanText = cleanText.replace(/^You sent\s*/i, '');
          } else if (buyerName) {
            const buyerPrefix = new RegExp(`^${buyerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\n]*`, 'i');
            cleanText = cleanText.replace(buyerPrefix, '');
          }
          cleanText = cleanText.replace(/\nEnter$/i, '').replace(/Enter$/i, '').trim();
          cleanText = cleanText.replace(/\n?Message sent$/i, '').trim();
          cleanText = cleanText.replace(/\n?Sent \d+[mhd] ago$/i, '').trim();
        }

        // Fallback: if innerText gave nothing useful, try div[dir="auto"] concatenation
        if (!cleanText || cleanText.length < 1) {
          const dirAutos = row.querySelectorAll('div[dir="auto"]');
          const textParts = [];
          for (const da of dirAutos) {
            const t = da.textContent?.trim();
            if (t && t.length > 0) {
              textParts.push(t);
            }
          }
          if (textParts.length > 0) {
            cleanText = textParts.reduce((a, b) => (a.length >= b.length ? a : b), '');
          }
        }

        if (!cleanText || cleanText.length < 1) { debug.push(`SKIP notext: "${fullText.substring(0,60)}"`); continue; }

        // Skip messages that are just the buyer's name (sender labels in the DOM).
        // FB shows "Romeo Lassiter" as a label before each message group.
        // Only skip if the normalized text is very close in length to the buyer name
        // (within 3 chars), to avoid filtering real messages like emails that happen
        // to start with the buyer's name after normalization.
        if (cleanText.length < 50) {
          const normClean = cleanText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
          const normBuyer = buyerName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
          const lenDiff = Math.abs(normClean.length - normBuyer.length);
          if (normClean && normBuyer && lenDiff <= 3 && (
            normClean === normBuyer ||
            normBuyer.startsWith(normClean) ||
            normClean.startsWith(normBuyer)
          )) {
            debug.push(`SKIP name-label: clean="${cleanText}" normC="${normClean}" normB="${normBuyer}"`);
            continue;
          }
        }

        // Skip FB's quick response option texts and notification messages
        if (cleanText.includes('Yes. Are you interested')) { debug.push(`SKIP quick-resp: "${cleanText.substring(0,60)}"`); continue; }
        if (cleanText.includes("I'll let you know")) { debug.push(`SKIP quick-resp: "${cleanText.substring(0,60)}"`); continue; }
        if (cleanText.includes("it's not available")) { debug.push(`SKIP quick-resp: "${cleanText.substring(0,60)}"`); continue; }
        if (/^message sent$/i.test(cleanText)) { debug.push(`SKIP msg-sent`); continue; }

        // Skip FB system messages that survive the SKIP_PHRASES filter
        // (these get concatenated with buyer name prefix and other DOM text)
        if (/you can now rate each other/i.test(cleanText)) { debug.push(`SKIP sys: rate-each-other`); continue; }
        if (/people may rate one another/i.test(cleanText)) { debug.push(`SKIP sys: rate-one-another`); continue; }
        if (/based on their interactions/i.test(cleanText)) { debug.push(`SKIP sys: interactions`); continue; }
        if (/is a buyer on marketplace/i.test(cleanText)) { debug.push(`SKIP sys: buyer-on-marketplace`); continue; }
        if (/typically replies/i.test(cleanText)) { debug.push(`SKIP sys: typically-replies`); continue; }
        if (/joined facebook in/i.test(cleanText)) { debug.push(`SKIP sys: joined-facebook`); continue; }

        // Skip rows that are FB timestamp labels.
        // Pattern: "Today at 18:45\n18:45" or "Yesterday at 14:30\n14:30".
        // These are timestamp dividers FB puts between message groups.
        // Also skip if the entire text is "Today at HH:MM" with no message content.
        const firstLine = cleanText.split('\n')[0].trim();
        const isTimestampLabel =
          /^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(at\s+)?\d{1,2}:\d{2}/i.test(firstLine);
        if (isTimestampLabel) { debug.push(`SKIP timestamp: "${firstLine}"`); continue; }

        // Determine if buyer: either name-prefixed, or NOT from us
        const isBuyer = isBuyerByName || (!isSentByUs && !isBuyerByName);

        // Skip standalone signature lines (e.g. "- Alex") — part of our previous response
        if (isSentByUs && /^-\s*\w+$/.test(cleanText)) { debug.push(`SKIP signature: "${cleanText}"`); continue; }

        // Log for debugging
        debug.push(`KEEP: x=${Math.round(rect.x)} sender=${isSentByUs?'us':isBuyerByName?'buyer':'unknown'} text="${fullText.substring(0,80)}"`);

        results.push({
          sender: isBuyer ? buyerName : 'Me',
          text: cleanText,
          timestamp: '',
          isBuyer
        });
      }

      // --- Strategy 2: If no rows found, try div[dir="auto"] in the chat area ---
      if (results.length === 0) {
        const chatArea = document.querySelector('[data-scope="messages_table"]')
          || document.querySelector('[role="main"]');
        if (chatArea) {
          const autos = chatArea.querySelectorAll('div[dir="auto"]');
          for (const da of autos) {
            const rect = da.getBoundingClientRect();
            if (rect.x < 500) continue; // Must be in right panel
            const t = da.textContent?.trim();
            if (!t || t.length < 2 || t.length > 500) continue;

            let isNoise = false;
            for (const phrase of SKIP_PHRASES) {
              if (t.includes(phrase)) { isNoise = true; break; }
            }
            if (isNoise) continue;

            // Check if this is from us or buyer
            const parentText = da.parentElement?.parentElement?.textContent || '';
            const fromUs = parentText.includes('You sent');
            debug.push(`auto: x=${Math.round(rect.x)} fromUs=${fromUs} text="${t.substring(0,50)}"`);

            results.push({
              sender: fromUs ? 'Me' : buyerName,
              text: t,
              timestamp: '',
              isBuyer: !fromUs
            });
          }
        }
      }

      return { results, debug };
    }, thread.buyerName);

    // Log debug info
    if (messages.debug && messages.debug.length > 0) {
      console.log(`[inbox-monitor] Chat DOM debug (${messages.debug.length} elements):`);
      messages.debug.forEach(d => console.log(`[inbox-monitor]   ${d}`));
    }

    const extracted = messages.results || messages;

    console.log(`[inbox-monitor] Extracted ${extracted.length} message(s) from thread`);
    for (const m of extracted) {
      console.log(`[inbox-monitor]   ${m.isBuyer ? '←' : '→'} ${m.sender}: ${m.text.substring(0, 60)}`);
    }
    return extracted;
  }

  /**
   * Open a thread in Messenger mode.
   * Click the conversation row in the sidebar, or navigate directly if we have an href.
   * Then extract messages from the main chat area.
   */
  async _openMessengerThread(thread) {
    const buyerName = thread.buyerName;

    // If the thread is already visible in the chat panel, skip clicking
    if (thread._alreadyOpen) {
      console.log(`[inbox-monitor] Thread already open for ${buyerName}`);
      await this.takeScreenshot(`chat_${buyerName}`);
      // Fall through to message extraction below
    }
    // Strategy 1: If we have a direct Messenger href, navigate to it
    else if (thread._messengerHref) {
      const url = thread._messengerHref.startsWith('http')
        ? thread._messengerHref
        : `https://www.facebook.com${thread._messengerHref}`;
      console.log(`[inbox-monitor] Navigating to Messenger thread: ${url}`);
      await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await humanDelay(2000, 4000);
      await this.dismissOverlays();
    } else {
      // Strategy 2: Click the conversation row by buyer name
      const clicked = await this.page.evaluate((buyer) => {
        const normalize = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const normBuyer = normalize(buyer);

        // Try rows, list items, and links in the conversation list
        const candidates = document.querySelectorAll(
          'a[role="row"], [role="row"], [role="listitem"], [role="option"]'
        );
        for (const el of candidates) {
          if (el.offsetParent === null) continue;
          const rect = el.getBoundingClientRect();
          if (rect.x > 400) continue; // Must be in left sidebar

          const text = normalize(el.textContent);
          if (text.includes(normBuyer)) {
            el.click();
            return text.substring(0, 60);
          }
        }
        return null;
      }, buyerName);

      if (!clicked) {
        console.log(`[inbox-monitor] Could not find Messenger thread for ${buyerName}`);
        return [];
      }
      console.log(`[inbox-monitor] Clicked Messenger thread: ${clicked}`);
      await humanDelay(3000, 5000);
    }

    await this.takeScreenshot(`chat_${buyerName}`);

    await this._scrollChatToBottom();

    // Extract messages from Messenger's main chat area.
    // Messenger (2026) shows messages in the right/main panel.
    // Messages use div[dir="auto"] for text content, with sender grouping.
    const messages = await this.page.evaluate((buyerName) => {
      const results = [];
      const debug = [];

      const SKIP_PHRASES = [
        'started this chat', 'Send a quick response', 'Tap a response',
        'View buyer profile', 'Loading...', 'Beware of', 'common scam',
        'View listing', 'You can now rate each other', 'People may rate',
        'is a buyer on Marketplace', 'Replying as', 'typically replies',
        'joined Facebook in', 'Lives in', 'Rate ',
        'waiting for your response', 'is waiting for your', 'sent you a message',
      ];

      // Messenger uses [role="row"] or message-like containers in the main panel
      const rows = document.querySelectorAll('[role="row"], [role="gridcell"]');
      const mainArea = document.querySelector('[role="main"]');

      // If we have role="row" elements, use them
      for (const row of rows) {
        if (row.offsetParent === null) continue;
        const rect = row.getBoundingClientRect();
        // Messages are in the main/right area (x > 300 typically)
        if (rect.x < 300 || rect.width < 100) continue;

        const fullText = row.textContent?.trim() || '';
        if (!fullText || fullText.length < 2) continue;

        // Skip noise
        let isNoise = false;
        for (const phrase of SKIP_PHRASES) {
          if (fullText.includes(phrase)) { isNoise = true; break; }
        }
        if (isNoise) continue;

        // Skip if it contains the dot separator (header row from Marketplace)
        if (fullText.includes('·') || fullText.includes('\u00B7')) continue;

        const isSentByUs = fullText.startsWith('You sent') || fullText.startsWith('You:');
        const isBuyerByName = fullText.startsWith(buyerName);

        // Extract clean text
        const rowInnerText = row.innerText?.trim() || '';
        let cleanText = rowInnerText;
        if (isSentByUs) {
          cleanText = cleanText.replace(/^You sent\s*/i, '').replace(/^You:\s*/i, '');
        } else if (buyerName) {
          const re = new RegExp(`^${buyerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\n]*`, 'i');
          cleanText = cleanText.replace(re, '');
        }
        cleanText = cleanText.replace(/\nEnter$/i, '').replace(/Enter$/i, '').trim();
        cleanText = cleanText.replace(/\n?Message sent$/i, '').trim();
        cleanText = cleanText.replace(/\n?Sent \d+[mhd] ago$/i, '').trim();

        if (!cleanText || cleanText.length < 2) continue;

        // Skip name-only labels (but not real messages like emails that start with buyer name)
        const normClean = cleanText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const normBuyer = buyerName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const lenDiff = Math.abs(normClean.length - normBuyer.length);
        if (normClean && normBuyer && lenDiff <= 3 && (normClean === normBuyer || normBuyer.startsWith(normClean))) continue;

        // Skip timestamps
        if (/^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(at\s+)?\d/i.test(cleanText)) continue;

        const isBuyer = isBuyerByName || (!isSentByUs && !isBuyerByName);

        debug.push(`msg: sender=${isSentByUs?'us':'buyer'} text="${cleanText.substring(0,50)}"`);
        results.push({
          sender: isBuyer ? buyerName : 'Me',
          text: cleanText,
          timestamp: '',
          isBuyer,
        });
      }

      // Fallback: use div[dir="auto"] in main area
      if (results.length === 0 && mainArea) {
        const autos = mainArea.querySelectorAll('div[dir="auto"]');
        for (const da of autos) {
          const rect = da.getBoundingClientRect();
          if (rect.x < 300) continue;
          const t = da.textContent?.trim();
          if (!t || t.length < 2 || t.length > 500) continue;

          let isNoise = false;
          for (const phrase of SKIP_PHRASES) {
            if (t.includes(phrase)) { isNoise = true; break; }
          }
          if (isNoise) continue;

          const parentText = da.parentElement?.parentElement?.textContent || '';
          const fromUs = parentText.includes('You sent') || parentText.includes('You:');

          debug.push(`auto: fromUs=${fromUs} text="${t.substring(0,50)}"`);
          results.push({
            sender: fromUs ? 'Me' : buyerName,
            text: t,
            timestamp: '',
            isBuyer: !fromUs,
          });
        }
      }

      return { results, debug };
    }, buyerName);

    if (messages.debug && messages.debug.length > 0) {
      console.log(`[inbox-monitor] Messenger chat debug (${messages.debug.length} elements):`);
      messages.debug.forEach(d => console.log(`[inbox-monitor]   ${d}`));
    }

    const extracted = messages.results || messages;
    console.log(`[inbox-monitor] Extracted ${extracted.length} message(s) from Messenger thread`);
    for (const m of extracted) {
      console.log(`[inbox-monitor]   ${m.isBuyer ? '←' : '→'} ${m.sender}: ${m.text.substring(0, 60)}`);
    }
    return extracted;
  }

  /**
   * Read messages from a thread by navigating directly to its Messenger URL.
   * No inbox row clicking needed - uses the real thread ID from GraphQL.
   */
  async readThreadViaMessenger(thread) {
    const threadId = thread.realThreadId || thread._realFbId;
    if (!threadId) {
      console.warn(`[inbox-monitor] No real thread ID for ${thread.buyerName}, falling back to openThread`);
      return this.openThread(thread);
    }

    const url = `https://www.facebook.com/messages/t/${threadId}`;
    console.log(`[inbox-monitor] Reading ${thread.buyerName} via Messenger: ${url}`);

    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await humanDelay(3000, 4000);

    // Dismiss dialogs
    await this._dismissMessengerDialogs().catch(() => {});

    // Wait for chat to load, then scroll to bottom
    await humanDelay(2000, 3000);
    await this._scrollChatToBottom();
    await new Promise(r => setTimeout(r, 2000));
    await this._scrollChatToBottom();

    // Extract the buyer name from the header if we don't have it
    const header = await this._extractActiveThreadHeader();
    if (header?.buyerName && (!thread.buyerName || thread.buyerName === 'Unknown')) {
      thread.buyerName = header.buyerName;
    }

    await this.takeScreenshot(`chat_${thread.buyerName}`);

    // Extract messages - reuse the existing Messenger message extraction
    const buyerName = thread.buyerName || 'Unknown';
    const messages = await this.page.evaluate((buyerName) => {
      const results = [];
      const SKIP_PHRASES = [
        'started this chat', 'Send a quick response', 'Tap a response',
        'View buyer profile', 'Loading...', 'Beware of', 'common scam',
        'View listing', 'You can now rate each other', 'People may rate',
        'is a buyer on Marketplace', 'Replying as', 'typically replies',
        'joined Facebook in', 'Lives in', 'Rate ',
        'waiting for your response', 'is waiting for your', 'sent you a message',
      ];

      const rows = document.querySelectorAll('[role="row"], [role="gridcell"]');

      for (const row of rows) {
        if (row.offsetParent === null) continue;
        const rect = row.getBoundingClientRect();
        if (rect.x < 300 || rect.width < 100) continue;

        const fullText = row.textContent?.trim() || '';
        if (!fullText || fullText.length < 2) continue;

        let isNoise = false;
        for (const phrase of SKIP_PHRASES) {
          if (fullText.includes(phrase)) {
            isNoise = true;
            break;
          }
        }
        if (isNoise) continue;

        if (fullText.includes('·') || fullText.includes('\u00B7')) continue;

        const isSentByUs = fullText.startsWith('You sent') || fullText.startsWith('You:');
        const isBuyerByName = fullText.startsWith(buyerName);

        let cleanText = row.innerText?.trim() || '';
        if (isSentByUs) {
          cleanText = cleanText.replace(/^You sent\s*/i, '').replace(/^You:\s*/i, '');
        } else if (buyerName) {
          const re = new RegExp(`^${buyerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\n]*`, 'i');
          cleanText = cleanText.replace(re, '');
        }
        cleanText = cleanText.replace(/\nEnter$/i, '').replace(/Enter$/i, '').trim();
        cleanText = cleanText.replace(/\n?Message sent$/i, '').trim();
        cleanText = cleanText.replace(/\n?Sent \d+[mhd] ago$/i, '').trim();

        if (!cleanText || cleanText.length < 2) continue;

        // Skip name-only labels
        const normClean = cleanText.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const normBuyer = buyerName.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const lenDiff = Math.abs(normClean.length - normBuyer.length);
        if (normClean && normBuyer && lenDiff <= 3 && (normClean === normBuyer || normBuyer.startsWith(normClean))) continue;

        // Skip timestamps
        if (/^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(at\s+)?\d/i.test(cleanText)) continue;

        const isBuyer = isBuyerByName || (!isSentByUs && !isBuyerByName);

        results.push({
          sender: isBuyer ? buyerName : 'Me',
          text: cleanText,
          timestamp: '',
          isBuyer,
        });
      }

      return results;
    }, buyerName);

    console.log(`[inbox-monitor] Extracted ${messages.length} message(s) from Messenger`);
    for (const m of messages) {
      console.log(`[inbox-monitor]   ${m.isBuyer ? '<-' : '->'} ${m.sender}: ${m.text.substring(0, 60)}`);
    }
    return messages;
  }

  /**
   * Send a message via direct Messenger URL navigation.
   * If the page is already on this thread's Messenger URL, skip navigation.
   */
  async sendViaMessenger(threadId, text, expectedBuyer) {
    const messengerUrl = `https://www.facebook.com/messages/t/${threadId}`;
    console.log(`[inbox-monitor] Sending via Messenger to ${expectedBuyer} (${threadId})...`);

    // Check if we're already on the right Messenger page
    const currentUrl = this.page.url();
    if (!currentUrl.includes(`/messages/t/${threadId}`)) {
      await this.page.goto(messengerUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      await humanDelay(2000, 4000);
      await this._dismissMessengerDialogs().catch(() => {});
    }

    // Now call the existing sendMessage which handles textbox finding + typing
    return this.sendMessage(text, expectedBuyer);
  }

  /**
   * Send a message in the currently open Marketplace chat panel.
   *
   * The chat panel has a textbox area at the bottom with icons
   * (mic, photo, sticker, GIF, emoji, thumbs up). The textbox may
   * have width=0 initially and needs to be clicked/focused first.
   *
   * @param {string} text - Message text to send
   * @param {string} expectedBuyer - Buyer name to verify we're in the right chat
   * @param {string} realFbUrl - Thread URL captured from a previous open
   * @returns {boolean} Whether the message was sent
   */
  async sendMessage(text, expectedBuyer, realFbUrl) {
    console.log(`[inbox-monitor] Sending message (${text.length} chars) to ${expectedBuyer || 'unknown'}...`);

    if (realFbUrl) {
      const targetUrl = realFbUrl.startsWith('http')
        ? realFbUrl
        : new URL(realFbUrl, 'https://www.facebook.com').toString();
      console.log(`[inbox-monitor] Navigating directly to thread URL: ${targetUrl}`);

      await this.page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      await humanDelay(2000, 4000);
      await this.page.evaluate(() => {
        for (const dialog of document.querySelectorAll('[role="dialog"]')) {
          if (dialog.offsetParent === null) continue;
          for (const btn of dialog.querySelectorAll('[role="button"], button, [aria-label="Close"]')) {
            const text = btn.textContent?.trim().toLowerCase() || '';
            const label = btn.getAttribute('aria-label')?.toLowerCase() || '';
            if (label === 'close' || text === 'close' || text === 'not now' ||
                text === 'skip' || text === 'dismiss' || text === 'got it') {
              btn.click();
              break;
            }
          }
        }
      });
      await new Promise(r => setTimeout(r, 500));

      if (/\/messages\//i.test(targetUrl)) {
        await this._dismissMessengerDialogs();
        this._usingMessenger = true;
      } else {
        this._usingMessenger = false;
        // Marketplace inbox URLs (?thread_id=XXX) load the inbox page but don't
        // open the chat popup. Click the matching thread row to open it.
        if (expectedBuyer) {
          const clickResult = await this._clickMarketplaceThreadRow({
            buyerName: expectedBuyer,
            listingTitle: '',
            lastMessage: '',
          });
          if (clickResult) {
            console.log(`[inbox-monitor] Clicked thread row after URL nav: ${clickResult}`);
            await humanDelay(3000, 5000);
          } else {
            console.warn(`[inbox-monitor] Could not click thread row for ${expectedBuyer} after URL nav`);
          }
        }
      }

      await this.page.waitForFunction(() => {
        return Boolean(
          document.querySelector('[role="textbox"][contenteditable="true"]')
          || document.querySelector('[contenteditable="true"]')
          || document.querySelector('[role="heading"]')
          || document.querySelector('h2')
          || document.querySelector('h3')
        );
      }, { timeout: 10000 }).catch(() => {});
    }

    // Verify the active chat panel belongs to the expected buyer
    // Skip safety check for "Unknown" buyer — can't verify a name we don't know
    if (expectedBuyer && !/^unknown$/i.test(expectedBuyer.trim())) {
      // Build name variants: full name, first name, last name
      const buyerParts = expectedBuyer.trim().split(/\s+/);
      const nameVariants = [expectedBuyer, ...buyerParts].filter(n => n.length > 1);

      const chatHeader = await this.page.evaluate((variants) => {
        const norm = (s) => (s || '').toLowerCase().trim();
        const matches = (text) => variants.some(v => norm(text).includes(norm(v)));

        // Look for the buyer name in visible chat panel headers
        const headers = document.querySelectorAll('[role="heading"], h2, h3, [data-testid*="header"]');
        for (const h of headers) {
          if (h.offsetParent === null) continue;
          const text = h.textContent?.trim() || '';
          if (matches(text)) return text.substring(0, 80);
        }
        // Also check any element near the top of the chat area that has the buyer name
        const allEls = document.querySelectorAll('span, a, strong');
        for (const el of allEls) {
          const rect = el.getBoundingClientRect();
          if (rect.x > 400 && rect.y < 120 && rect.y > 30) {
            const t = el.textContent?.trim() || '';
            if (matches(t) && t.length < 100) return t.substring(0, 80);
          }
        }
        return null;
      }, nameVariants);

      if (!chatHeader) {
        console.error(`[inbox-monitor] SAFETY: Chat header does not show "${expectedBuyer}" — aborting send to prevent wrong-recipient delivery`);
        await this.takeScreenshot('send_wrong_chat');
        return false;
      }
      console.log(`[inbox-monitor] Verified chat is for: ${chatHeader}`);
    }

    // Strategy 1: Find contenteditable textbox in the chat panel (right side)
    let textbox = await this.page.$('[role="textbox"][contenteditable="true"]');

    // If multiple textboxes exist, prefer the one in the expected buyer's chat panel.
    if (textbox) {
      const allTextboxes = await this.page.$$('[role="textbox"][contenteditable="true"]');
      if (allTextboxes.length > 1) {
        console.log(`[inbox-monitor] Found ${allTextboxes.length} textboxes - picking the one in ${expectedBuyer || 'the expected buyer'}'s panel`);
        let bestBox = null;
        let bestY = -1;
        if (expectedBuyer) {
          for (const box of allTextboxes) {
            const rect = await box.boundingBox();
            if (!rect) continue;
            const panelText = await box.evaluate((el, buyer) => {
              let node = el;
              for (let i = 0; i < 20; i++) {
                node = node.parentElement;
                if (!node) break;
                const text = node.textContent || '';
                if (text.includes(buyer) && text.length < 5000) return buyer;
              }
              return null;
            }, expectedBuyer);
            if (panelText && rect.y > bestY) {
              bestY = rect.y;
              bestBox = box;
            }
          }
        }
        if (!bestBox) {
          for (const box of allTextboxes) {
            const rect = await box.boundingBox();
            if (rect && rect.y > bestY) {
              bestY = rect.y;
              bestBox = box;
            }
          }
        }
        if (bestBox) textbox = bestBox;
      }
    }

    // Strategy 2: Try broader selectors for Messenger compose box
    if (!textbox) {
      textbox = await this.page.evaluateHandle(() => {
        // Look for contenteditable divs that are likely the compose box
        const editables = document.querySelectorAll('[contenteditable="true"]');
        for (const el of editables) {
          // The compose box is typically at the bottom of the chat panel
          const rect = el.getBoundingClientRect();
          if (rect.bottom > window.innerHeight * 0.5 && rect.width > 200) {
            return el;
          }
        }
        // Fallback: look near emoji/GIF buttons
        const buttons = document.querySelectorAll('[aria-label*="emoji" i], [aria-label*="GIF" i]');
        for (const btn of buttons) {
          const parent = btn.parentElement?.parentElement;
          if (parent) {
            const input = parent.querySelector('[contenteditable], [role="textbox"], textarea');
            if (input) return input;
          }
        }
        return null;
      }).then(h => h && h.asElement ? h.asElement() : null).catch(() => null);
    }

    // Strategy 3: Click in the general area where the textbox should be
    if (!textbox) {
      // The textbox is at the bottom-right of the viewport in the chat panel
      await this.page.mouse.click(1100, 730);
      await humanDelay(500, 1000);
      textbox = await this.page.$('[role="textbox"][contenteditable="true"]')
        || await this.page.$('[contenteditable="true"]');
    }

    if (!textbox) {
      console.log('[inbox-monitor] Could not find message compose box');
      await this.takeScreenshot('send_message_no_textbox');
      return false;
    }

    // Click the textbox to focus it
    await textbox.click();
    await humanDelay(300, 600);

    // Type the message with human-like speed in chunks
    const chunkSize = 50;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      await textbox.type(chunk, { delay: Math.random() * 30 + 20 });
      if (i + chunkSize < text.length) {
        await humanDelay(100, 300);
      }
    }

    await humanDelay(500, 1000);

    // Press Enter to send
    await this.page.keyboard.press('Enter');
    await humanDelay(1000, 2000);

    console.log('[inbox-monitor] Message sent');
    return true;
  }

  /**
   * Match a listing title to a vehicle in inventory.
   * Tries post_id match first, then fuzzy year/make/model parsing.
   *
   * @param {string} listingTitle - Title from the thread/listing
   * @param {Array} inventory - Array of vehicle objects
   * @returns {object|null} Matched vehicle or null
   */
  matchToVehicle(listingTitle, inventory) {
    if (!listingTitle || !inventory || inventory.length === 0) return null;

    const lower = listingTitle.toLowerCase();

    // Strategy 1: Match by post_id if the listing URL/title contains it
    for (const v of inventory) {
      const postId = v.listings?.facebook_marketplace?.post_id;
      if (postId && lower.includes(postId)) {
        return v;
      }
    }

    // Strategy 2: Fuzzy match on year, make, model
    let bestMatch = null;
    let bestScore = 0;

    for (const v of inventory) {
      let score = 0;

      // Check year
      if (v.year && lower.includes(v.year.toString())) {
        score += 3;
      }

      // Check make (case-insensitive)
      if (v.make && lower.includes(v.make.toLowerCase())) {
        score += 3;
      }

      // Check model
      if (v.model && lower.includes(v.model.toLowerCase())) {
        score += 3;
      }

      // Check trim
      if (v.trim && lower.includes(v.trim.toLowerCase())) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = v;
      }
    }

    // Require at least year + make or make + model to match (score >= 6)
    // For small inventories (≤5 vehicles), accept a weaker match (make or model alone)
    const threshold = inventory.length <= 5 ? 3 : 6;
    if (bestScore >= threshold) {
      return bestMatch;
    }

    return null;
  }

  /**
   * Parse vehicle info (year/make/model) from free text when no inventory match.
   * Returns a synthetic vehicle-like object with display info, or null.
   */
  parseVehicleFromText(text) {
    if (!text) return null;
    const MAKES = [
      'Acura','Alfa Romeo','Audi','BMW','Buick','Cadillac','Chevrolet','Chevy',
      'Chrysler','Dodge','Fiat','Ford','Genesis','GMC','Honda','Hyundai','Infiniti',
      'Jaguar','Jeep','Kia','Land Rover','Lexus','Lincoln','Maserati','Mazda',
      'Mercedes','Mercedes-Benz','Mini','Mitsubishi','Nissan','Porsche','Ram',
      'Subaru','Tesla','Toyota','Volkswagen','VW','Volvo'
    ];
    // Match "YYYY Make Model..." pattern
    const yearPattern = text.match(/\b(19\d{2}|20[0-3]\d)\b/);
    if (!yearPattern) return null;
    const year = parseInt(yearPattern[1]);
    const afterYear = text.substring(text.indexOf(yearPattern[1]) + yearPattern[1].length).trim();
    for (const make of MAKES) {
      if (afterYear.toLowerCase().startsWith(make.toLowerCase())) {
        const afterMake = afterYear.substring(make.length).trim();
        // Model: extract first word (alphanumeric + hyphens), then clean:
        // - Split at lowercase→uppercase boundary ("AccordI'm" → "Accord")
        // - Trim trailing punctuation ("Accord-" → "Accord")
        const wordMatch = afterMake.match(/^([\w-]+)/);
        let model = wordMatch ? wordMatch[1] : '';
        model = model.replace(/([a-z])([A-Z]).*$/, '$1'); // split at camelCase
        model = model.replace(/[-_.,]+$/, ''); // trim trailing punctuation
        return {
          year, make, model: model || 'Unknown',
          vin: null,
          _parsed: true, // flag: not from inventory
          _summary: `${year} ${make}${model ? ' ' + model : ''}`
        };
      }
    }
    return null;
  }

  /**
   * Take a screenshot for debugging
   */
  async takeScreenshot(name) {
    try {
      const filename = `inbox_${name}_${Date.now()}.png`;
      const filepath = path.join(SCREENSHOTS_DIR, filename);
      await this.page.screenshot({ path: filepath, fullPage: true });
      console.log(`[inbox-monitor] Screenshot: ${filename}`);
      this._pruneScreenshots();
      return filepath;
    } catch (e) {
      console.log(`[inbox-monitor] Screenshot failed (${name}): ${e.message}`);
      return null;
    }
  }

  /**
   * Keep only the most recent 50 screenshots to prevent disk bloat.
   * Runs async, doesn't block the caller.
   */
  _pruneScreenshots() {
    try {
      const MAX_SCREENSHOTS = 50;
      const files = fs.readdirSync(SCREENSHOTS_DIR)
        .filter(f => f.startsWith('inbox_') && f.endsWith('.png'))
        .map(f => ({ name: f, path: path.join(SCREENSHOTS_DIR, f), mtime: fs.statSync(path.join(SCREENSHOTS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > MAX_SCREENSHOTS) {
        for (const old of files.slice(MAX_SCREENSHOTS)) {
          fs.unlinkSync(old.path);
        }
        console.log(`[inbox-monitor] Pruned ${files.length - MAX_SCREENSHOTS} old screenshot(s)`);
      }
    } catch { /* ignore cleanup errors */ }
  }

  /**
   * Close browser.
   * If connected to existing Chrome: disconnect without closing Chrome.
   * If we launched a browser: save session and close it.
   */
  isAlive() {
    try {
      return !!(this.browser && this.page && !this.page.isClosed());
    } catch {
      return false;
    }
  }

  /**
   * Release the inbox page — do NOT close the shared browser.
   */
  async close() {
    console.log('[inbox-monitor] Releasing inbox page...');
    if (this.page && this._responseHandler && typeof this.page.off === 'function') {
      this.page.off('response', this._responseHandler);
    }
    this._responseHandler = null;
    this._responseInterceptionSetup = false;
    this._graphqlThreads = [];
    await SharedBrowser.releasePage(this.salespersonId, 'inbox').catch(() => {});
    this.browser = null;
    this.page = null;
    console.log('[inbox-monitor] Inbox page released');
  }
}

module.exports = { InboxMonitor, humanDelay };
