/**
 * Shared Browser Manager
 *
 * Singleton that manages one Chrome instance per salesperson ID.
 * Auth, poster, and inbox all share the same browser as separate tabs,
 * coordinated by a navigation mutex so only one module navigates at a time.
 *
 * Benefits:
 *   - 1 Chrome process instead of 3 → lower memory
 *   - Single profile dir → consistent cookies/session
 *   - Turn-based navigation looks natural to Facebook
 *   - Crash recovery auto-relaunches Chrome
 */

'use strict';

const { addExtra } = require('puppeteer-extra');
const puppeteerCore = require('puppeteer-core');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { sharedChromeProfileDir, ensureDirs } = require('./paths');

// Register stealth plugin once for the process
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

const VIEWPORT = { width: 1366, height: 768 };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MUTEX_DEADLOCK_TIMEOUT = 5 * 60 * 1000; // 5 min
const CRASH_RELAUNCH_DELAY = 2000;

// ─── NavigationMutex ────────────────────────────────────────────────────────

class NavigationMutex {
  constructor() {
    this._queue = [];
    this._holder = null;
    this._holderTimer = null;
  }

  /**
   * Acquire the mutex. Returns an unlock() function.
   * Auth gets priority (jumps to front of queue).
   * @param {string} owner - 'auth' | 'poster' | 'inbox'
   * @param {number} [maxHoldMs] - Override deadlock timeout
   */
  async lock(owner, maxHoldMs) {
    const timeout = maxHoldMs || MUTEX_DEADLOCK_TIMEOUT;

    if (!this._holder) {
      return this._grant(owner, timeout);
    }

    // Queue the request; auth gets priority
    return new Promise((resolve, reject) => {
      const entry = { owner, resolve, reject, timeout };
      if (owner === 'auth') {
        this._queue.unshift(entry);
      } else {
        this._queue.push(entry);
      }
    });
  }

  _grant(owner, timeout) {
    this._holder = owner;
    let released = false;
    const unlock = () => {
      if (released) return;
      released = true;
      clearTimeout(this._holderTimer);
      this._holder = null;
      this._holderTimer = null;
      this._drainNext();
    };
    this._holderTimer = setTimeout(() => {
      console.warn(`[shared-browser] Mutex deadlock timeout — ${owner} held lock for ${timeout}ms, force-releasing`);
      unlock();
    }, timeout);
    return unlock;
  }

  _drainNext() {
    if (this._queue.length === 0) return;
    const next = this._queue.shift();
    const unlock = this._grant(next.owner, next.timeout);
    next.resolve(unlock);
  }

  get currentHolder() {
    return this._holder;
  }

  /** Force-release everything (used on teardown) */
  reset() {
    clearTimeout(this._holderTimer);
    this._holder = null;
    this._holderTimer = null;
    for (const entry of this._queue) {
      entry.reject(new Error('Mutex reset — browser torn down'));
    }
    this._queue = [];
  }
}

// ─── BrowserSlot ────────────────────────────────────────────────────────────

/**
 * Holds one Chrome browser, its pages, state, and mutex.
 */
class BrowserSlot {
  constructor(salespersonId) {
    this.salespersonId = salespersonId;
    this.browser = null;
    this.profileDir = null;
    this.state = 'idle'; // idle | launching | ready | auth_active | crashed
    this.pages = new Map(); // owner → Puppeteer.Page
    this.mutex = new NavigationMutex();
    this._authActive = false;
    this._disconnectHandler = null;
    this._launching = null; // Promise while launch is in progress
  }
}

// ─── SharedBrowser (Singleton) ──────────────────────────────────────────────

/** @type {Map<string, BrowserSlot>} */
const slots = new Map();

const SharedBrowser = {
  /**
   * Ensure a browser is launched for the given salesperson.
   * Returns the BrowserSlot.
   */
  async acquire(salespersonId) {
    let slot = slots.get(salespersonId);
    if (slot && slot.browser && slot.state !== 'crashed') {
      return slot;
    }

    // If already launching, wait for that to finish
    if (slot && slot._launching) {
      await slot._launching;
      return slot;
    }

    if (!slot) {
      slot = new BrowserSlot(salespersonId);
      slots.set(salespersonId, slot);
    }

    slot._launching = this._launchBrowser(slot);
    try {
      await slot._launching;
    } finally {
      slot._launching = null;
    }
    return slot;
  },

  async _launchBrowser(slot) {
    ensureDirs();
    slot.state = 'launching';

    const profileDir = sharedChromeProfileDir(slot.salespersonId);
    slot.profileDir = profileDir;

    const { ensureChrome, killStaleProfileChrome } = require('./chrome-path');
    await killStaleProfileChrome(profileDir);
    const executablePath = await ensureChrome({
      onProgress: (msg) => console.log('[shared-browser]', msg),
    });

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-position=-32000,-32000',
      '--js-flags=--max-old-space-size=256',
    ];
    if (process.env.PROXY_URL) {
      launchArgs.push(`--proxy-server=${process.env.PROXY_URL}`);
      launchArgs.push('--ignore-certificate-errors');
      console.log('[shared-browser] Using proxy:', process.env.PROXY_URL);
    }

    console.log(`[shared-browser] Launching Chrome for ${slot.salespersonId}...`);

    slot.browser = await puppeteer.launch({
      headless: false,
      args: launchArgs,
      executablePath,
      userDataDir: profileDir,
      defaultViewport: VIEWPORT,
    });

    const pid = slot.browser.process()?.pid || null;
    console.log(`[shared-browser] Chrome launched — PID=${pid} profile=${profileDir}`);

    // Minimize the Chrome window so it doesn't appear on screen (especially Mac
    // which ignores the --window-position off-screen trick). Uses CDP to minimize
    // the browser window without switching to headless mode (which FB detects).
    await this.minimizeWindow(slot.salespersonId);

    // Crash recovery
    slot._disconnectHandler = () => {
      console.error(`[shared-browser] Chrome DISCONNECTED for ${slot.salespersonId} (PID=${pid})`);
      slot.state = 'crashed';
      slot.browser = null;
      // Notify all page owners their pages are dead
      slot.pages.clear();
      slot.mutex.reset();

      // Auto-relaunch after delay
      setTimeout(async () => {
        try {
          console.log(`[shared-browser] Auto-relaunching Chrome for ${slot.salespersonId}...`);
          await SharedBrowser._launchBrowser(slot);
        } catch (e) {
          console.error(`[shared-browser] Auto-relaunch failed: ${e.message}`);
        }
      }, CRASH_RELAUNCH_DELAY);
    };
    slot.browser.on('disconnected', slot._disconnectHandler);

    slot.state = 'ready';
  },

  /**
   * Create a new tab for the given owner. Returns the Puppeteer.Page.
   * If a page already exists for this owner, returns it.
   */
  async getPage(salespersonId, owner) {
    const slot = slots.get(salespersonId);
    if (!slot || !slot.browser) {
      throw new Error(`No browser for ${salespersonId} — call acquire() first`);
    }

    // Reuse existing page if still alive
    const existing = slot.pages.get(owner);
    if (existing && !existing.isClosed()) {
      return existing;
    }

    const page = await slot.browser.newPage();
    if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
      await page.authenticate({
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      });
    }
    await page.setViewport(VIEWPORT);
    await page.setUserAgent(USER_AGENT);
    page.setDefaultNavigationTimeout(60000);

    slot.pages.set(owner, page);
    console.log(`[shared-browser] Page created for ${owner} (${salespersonId})`);
    return page;
  },

  /**
   * Close a tab (NOT the browser).
   */
  async releasePage(salespersonId, owner) {
    const slot = slots.get(salespersonId);
    if (!slot) return;

    const page = slot.pages.get(owner);
    if (page) {
      slot.pages.delete(owner);
      try {
        if (!page.isClosed()) await page.close();
      } catch (_) {}
      console.log(`[shared-browser] Page released for ${owner} (${salespersonId})`);
    }
  },

  /**
   * Acquire the navigation mutex. Returns an unlock() function.
   */
  async lockNavigation(salespersonId, owner, maxHoldMs) {
    const slot = slots.get(salespersonId);
    if (!slot) throw new Error(`No browser slot for ${salespersonId}`);
    return slot.mutex.lock(owner, maxHoldMs);
  },

  /**
   * Whether auth is currently active (blocks poster/inbox).
   */
  isAuthActive(salespersonId) {
    const slot = slots.get(salespersonId);
    return slot ? slot._authActive : false;
  },

  /**
   * Set auth active state. When true, poster/inbox should not start.
   */
  setAuthActive(salespersonId, active) {
    const slot = slots.get(salespersonId);
    if (slot) {
      slot._authActive = active;
      slot.state = active ? 'auth_active' : 'ready';
      console.log(`[shared-browser] Auth active=${active} for ${salespersonId}`);
    }
  },

  /**
   * Get raw Puppeteer.Browser reference.
   */
  getBrowser(salespersonId) {
    const slot = slots.get(salespersonId);
    return slot ? slot.browser : null;
  },

  /**
   * Re-minimize the browser window (Mac un-minimizes on navigation).
   */
  async minimizeWindow(salespersonId) {
    const slot = slots.get(salespersonId);
    if (!slot?.browser) return;

    let cdp = null;
    try {
      const pages = await slot.browser.pages();
      if (pages.length === 0) return;

      cdp = await pages[0].createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' },
      });
    } catch (_) {
      // Best-effort only.
    } finally {
      if (cdp) {
        await cdp.detach().catch(() => {});
      }
    }
  },

  /**
   * Kill browser and clean up for a specific user (e.g., user switch).
   */
  async teardown(salespersonId) {
    const slot = slots.get(salespersonId);
    if (!slot) return;

    console.log(`[shared-browser] Tearing down browser for ${salespersonId}`);

    slot.mutex.reset();
    slot._authActive = false;

    // Close all pages
    for (const [owner, page] of slot.pages) {
      try {
        if (!page.isClosed()) await page.close();
      } catch (_) {}
    }
    slot.pages.clear();

    // Close browser
    if (slot.browser) {
      // Remove disconnect handler to avoid auto-relaunch
      if (slot._disconnectHandler) {
        slot.browser.removeListener('disconnected', slot._disconnectHandler);
      }
      try {
        await slot.browser.close();
      } catch (_) {}
      slot.browser = null;
    }

    slot.state = 'idle';
    slots.delete(salespersonId);
    console.log(`[shared-browser] Teardown complete for ${salespersonId}`);
  },

  /**
   * Kill all browsers (app quit).
   */
  async teardownAll() {
    console.log(`[shared-browser] Tearing down all browsers (${slots.size} active)`);
    const ids = [...slots.keys()];
    await Promise.allSettled(ids.map((id) => SharedBrowser.teardown(id)));
    console.log('[shared-browser] All browsers torn down');
  },
};

module.exports = { SharedBrowser, VIEWPORT, USER_AGENT };
