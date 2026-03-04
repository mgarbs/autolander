/**
 * Facebook Marketplace Inbox Monitor
 *
 * Puppeteer-based scraper that reads buyer messages from FB Marketplace
 * selling inbox and sends responses through Messenger.
 *
 * Reuses browser init, session/cookie management, stealth plugin, and
 * humanDelay() patterns from facebook-poster.js.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const http = require('http');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const DATA_DIR = process.env.AUTO_SALES_DATA_DIR || path.join(__dirname, '../data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

[SESSIONS_DIR, SCREENSHOTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

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
    this.headless = process.env.BROWSER_VISIBLE === 'true' ? false : (options.headless !== false);
    this.slowMo = options.slowMo || 50;
    this.browser = null;
    this.page = null;
    this.isLoggedIn = false;
    this.isConnected = false; // true when connected to existing Chrome (vs launched)
    this.debugPort = options.debugPort || process.env.CHROME_DEBUG_PORT || 9222;
    this.sessionFile = path.join(SESSIONS_DIR, `${this.salespersonId}_fb_session.json`);
  }

  /**
   * Fetch the WebSocket debugger URL from a running Chrome instance.
   * Same pattern as facebook-poster.js.
   */
  async _getDebuggerWSEndpoint() {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${this.debugPort}/json/version`, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.webSocketDebuggerUrl || null);
          } catch (_) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  /**
   * Auto-launch Chrome with remote debugging if not already running.
   * Returns true if Chrome was launched (or was already running), false on failure.
   */
  async _ensureChromeDebug() {
    // Check if already running
    const existing = await this._getDebuggerWSEndpoint();
    if (existing) return true;

    console.log('[inbox-monitor] Chrome not running — auto-launching with remote debugging...');

    const { spawn } = require('child_process');

    // Find Chrome/Chromium cross-platform
    const chromePaths = [
      process.env.CHROME_PATH,
      process.env.PUPPETEER_EXECUTABLE_PATH,
      // Linux
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      // Windows
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
    ].filter(Boolean);

    let chromePath = null;
    for (const p of chromePaths) {
      if (fs.existsSync(p)) {
        chromePath = p;
        break;
      }
    }

    if (!chromePath) {
      console.error('[inbox-monitor] Could not find Chrome. Set CHROME_PATH env var.');
      return false;
    }

    console.log(`[inbox-monitor] Found Chrome: ${chromePath}`);

    const chromeArgs = [`--remote-debugging-port=${this.debugPort}`];
    // Add --no-sandbox for Docker/Linux (typically runs as root)
    if (process.platform !== 'win32') {
      chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--headless=new');
    }

    const child = spawn(chromePath, chromeArgs, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // Wait for debugger to become available (up to 15 seconds)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const ws = await this._getDebuggerWSEndpoint();
      if (ws) {
        console.log(`[inbox-monitor] Chrome launched — debugger active on port ${this.debugPort}`);
        return true;
      }
    }

    console.error('[inbox-monitor] Chrome launched but debugger not responding after 15s');
    return false;
  }

  /**
   * Initialize browser.
   * Tries to connect to existing Chrome with remote debugging first.
   * Auto-launches Chrome if not running.
   * Falls back to launching a fresh Puppeteer instance as last resort.
   */
  async init() {
    console.log('[inbox-monitor] Initializing browser...');

    // Step 1: Ensure Chrome with remote debugging is running (auto-launch if needed)
    await this._ensureChromeDebug();

    // Step 2: Try connecting to existing Chrome
    const wsEndpoint = await this._getDebuggerWSEndpoint();
    if (wsEndpoint) {
      try {
        console.log(`[inbox-monitor] Connecting to Chrome on port ${this.debugPort}...`);
        this.browser = await puppeteer.connect({
          browserWSEndpoint: wsEndpoint,
          defaultViewport: { width: 1366, height: 768 }
        });
        this.isConnected = true;

        this.browser.on('disconnected', () => {
          console.error('[inbox-monitor] Browser DISCONNECTED — Chrome was closed externally');
        });

        this.page = await this.browser.newPage();
        if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
          await this.page.authenticate({
            username: process.env.PROXY_USERNAME,
            password: process.env.PROXY_PASSWORD
          });
        }
        await this.page.setViewport({ width: 1366, height: 768 });
        this.page.setDefaultNavigationTimeout(60000);

        // Load saved cookies into the connected browser (needed for headless/Docker
        // where Chrome doesn't have a pre-existing Facebook session)
        await this.loadSession();

        console.log('[inbox-monitor] Connected to existing Chrome');
        return this;
      } catch (e) {
        console.warn(`[inbox-monitor] Failed to connect to Chrome: ${e.message}`);
        console.warn('[inbox-monitor] Falling back to launching new browser...');
      }
    }

    // Step 3: Fallback — launch new browser instance
    console.warn('[inbox-monitor] No Chrome debugger available, launching standalone browser...');

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768'
    ];
    if (process.env.PROXY_URL) {
      launchArgs.push(`--proxy-server=${process.env.PROXY_URL}`);
      launchArgs.push('--ignore-certificate-errors');
      console.log('[inbox] Using residential proxy:', process.env.PROXY_URL);
    }

    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

    this.browser = await puppeteer.launch({
      headless: this.headless ? 'new' : false,
      slowMo: this.slowMo,
      executablePath,
      args: launchArgs,
      defaultViewport: { width: 1366, height: 768 }
    });

    this.page = await this.browser.newPage();
    if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
      await this.page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
      });
    }

    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    this.page.setDefaultNavigationTimeout(60000);

    await this.loadSession();
    console.log('[inbox-monitor] Browser initialized (standalone mode)');
    return this;
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
      timeout: 30000
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

    await this.takeScreenshot('inbox_loaded');
    console.log('[inbox-monitor] On Marketplace inbox page');
    return true;
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
    console.log('[inbox-monitor] Scanning for conversations...');

    await humanDelay(1000, 2000);

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

        // Stable thread ID based on buyer name (not position)
        // This ensures the same buyer always maps to the same conversation state
        const threadId = 'inbox_' + buyerName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');

        // Skip duplicate buyer entries (nested DOM elements can repeat)
        if (results.some(r => r.threadId === threadId)) continue;

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
    console.log(`[inbox-monitor] Opening thread: ${thread.buyerName}`);

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

    // Click the conversation row by matching buyer name
    const clicked = await this.page.evaluate((buyerName, index) => {
      const DOT_CHARS = ['·', '\u00B7', '\u2022', '\u2027', '\u22C5'];
      function hasDot(text) {
        for (const d of DOT_CHARS) { if (text.includes(d)) return true; }
        return false;
      }

      const seen = new Set();
      const buttons = document.querySelectorAll('div[role="button"]');
      let matchIndex = 0;

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

        if (matchIndex === index) {
          btn.click();
          return text.substring(0, 60);
        }
        matchIndex++;
      }
      return null;
    }, thread.buyerName, thread._index || 0);

    if (!clicked) {
      console.log('[inbox-monitor] Could not click thread row');
      return [];
    }

    console.log(`[inbox-monitor] Clicked: ${clicked}`);
    await humanDelay(3000, 5000);

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

    // Screenshot the opened chat for debugging
    await this.takeScreenshot(`chat_${thread.buyerName}`);

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
        'Lives in'
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
        if (!fullText || fullText.length < 2) continue;

        // Skip the header row (contains "·" separator)
        if (fullText.includes('·') || fullText.includes('\u00B7')) continue;

        // Skip system/noise rows
        let isNoise = false;
        for (const phrase of SKIP_PHRASES) {
          if (fullText.includes(phrase)) { isNoise = true; break; }
        }
        if (isNoise) continue;

        // Determine sender:
        // "You sent" prefix = our message
        // BuyerName prefix = buyer message
        // Neither = could still be buyer (FB sometimes omits the name prefix)
        const isSentByUs = fullText.startsWith('You sent');
        const isBuyerByName = fullText.startsWith(buyerName);

        // Extract clean text from div[dir="auto"] inside this row
        const dirAutos = row.querySelectorAll('div[dir="auto"]');
        let cleanText = '';
        for (const da of dirAutos) {
          const t = da.textContent?.trim();
          if (t && t.length > 0) {
            cleanText = t;
            break;
          }
        }

        // If no dir=auto content, try innerText of the row itself
        if (!cleanText) {
          // Remove the sender prefix and trailing "Enter"
          cleanText = fullText
            .replace(/^You sent/i, '')
            .replace(new RegExp('^' + buyerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
            .replace(/Enter$/i, '')
            .trim();
        }

        if (!cleanText || cleanText.length < 1) continue;

        // Strip timestamp patterns that FB sometimes includes in text
        cleanText = cleanText.replace(/^Today at \d{1,2}:\d{2}\d{2}:\d{2}\s*/i, '').trim();
        cleanText = cleanText.replace(/^\d{1,2}:\d{2}\s*/, '').trim();

        if (!cleanText || cleanText.length < 1) continue;

        // Skip FB's quick response option texts and notification messages
        if (cleanText.includes('Yes. Are you interested')) continue;
        if (cleanText.includes("I'll let you know")) continue;
        if (cleanText.includes("it's not available")) continue;
        if (/^message sent$/i.test(cleanText)) continue;

        // Skip FB system messages that survive the SKIP_PHRASES filter
        // (these get concatenated with buyer name prefix and other DOM text)
        if (/you can now rate each other/i.test(cleanText)) continue;
        if (/people may rate one another/i.test(cleanText)) continue;
        if (/based on their interactions/i.test(cleanText)) continue;
        if (/is a buyer on marketplace/i.test(cleanText)) continue;
        if (/typically replies/i.test(cleanText)) continue;
        if (/joined facebook in/i.test(cleanText)) continue;

        // Determine if buyer: either name-prefixed, or NOT from us
        const isBuyer = isBuyerByName || (!isSentByUs && !isBuyerByName);

        // Skip standalone signature lines (e.g. "- Alex") — part of our previous response
        if (isSentByUs && /^-\s*\w+$/.test(cleanText)) continue;

        // Log for debugging
        debug.push(`row: x=${Math.round(rect.x)} sender=${isSentByUs?'us':isBuyerByName?'buyer':'unknown'} text="${fullText.substring(0,50)}"`);

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
   * Send a message in the currently open Marketplace chat panel.
   *
   * The chat panel has a textbox area at the bottom with icons
   * (mic, photo, sticker, GIF, emoji, thumbs up). The textbox may
   * have width=0 initially and needs to be clicked/focused first.
   *
   * @param {string} text - Message text to send
   * @param {string} expectedBuyer - Buyer name to verify we're in the right chat
   * @returns {boolean} Whether the message was sent
   */
  async sendMessage(text, expectedBuyer) {
    console.log(`[inbox-monitor] Sending message (${text.length} chars) to ${expectedBuyer || 'unknown'}...`);

    // Verify the active chat panel belongs to the expected buyer
    if (expectedBuyer) {
      const chatHeader = await this.page.evaluate((buyer) => {
        // Look for the buyer name in visible chat panel headers
        const headers = document.querySelectorAll('[role="heading"], h2, h3, [data-testid*="header"]');
        for (const h of headers) {
          if (h.offsetParent === null) continue;
          const text = h.textContent?.trim() || '';
          if (text.includes(buyer)) return text.substring(0, 80);
        }
        // Also check any element near the top of the chat area that has the buyer name
        const allEls = document.querySelectorAll('span, a, strong');
        for (const el of allEls) {
          const rect = el.getBoundingClientRect();
          if (rect.x > 400 && rect.y < 120 && rect.y > 30) {
            const t = el.textContent?.trim() || '';
            if (t.includes(buyer) && t.length < 100) return t.substring(0, 80);
          }
        }
        return null;
      }, expectedBuyer);

      if (!chatHeader) {
        console.error(`[inbox-monitor] SAFETY: Chat header does not show "${expectedBuyer}" — aborting send to prevent wrong-recipient delivery`);
        await this.takeScreenshot('send_wrong_chat');
        return false;
      }
      console.log(`[inbox-monitor] Verified chat is for: ${chatHeader}`);
    }

    // Strategy 1: Find contenteditable textbox in the chat panel (right side)
    let textbox = await this.page.$('[role="textbox"][contenteditable="true"]');

    // If multiple textboxes exist, pick the one closest to the bottom of the viewport
    // (the compose box is always at the bottom of the chat panel)
    if (textbox) {
      const allTextboxes = await this.page.$$('[role="textbox"][contenteditable="true"]');
      if (allTextboxes.length > 1) {
        console.log(`[inbox-monitor] Found ${allTextboxes.length} textboxes — picking bottom-most`);
        let bestBox = null;
        let bestY = -1;
        for (const box of allTextboxes) {
          const rect = await box.boundingBox();
          if (rect && rect.y > bestY) {
            bestY = rect.y;
            bestBox = box;
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
      return filepath;
    } catch (e) {
      console.log(`[inbox-monitor] Screenshot failed (${name}): ${e.message}`);
      return null;
    }
  }

  /**
   * Close browser.
   * If connected to existing Chrome: close our tab but leave Chrome running.
   * If we launched a browser: save session and close it.
   */
  async close() {
    if (this.browser) {
      if (this.isConnected) {
        // Connected mode: close our tab but leave Chrome running
        console.log('[inbox-monitor] Closing tab and disconnecting from Chrome...');
        if (this.page) {
          await this.page.close().catch(() => {});
        }
        this.browser.disconnect();
        console.log('[inbox-monitor] Disconnected from Chrome (browser stays open)');
      } else {
        // Launched mode: save session and close the browser we spawned
        await this.saveSession().catch(() => {});
        await this.browser.close();
        console.log('[inbox-monitor] Browser closed');
      }
      this.browser = null;
      this.page = null;
    }
  }
}

module.exports = { InboxMonitor, humanDelay };
