/**
 * Facebook Live Auth Session
 *
 * Manages an interactive Puppeteer browser session that streams its viewport
 * to a WebSocket client via the Chrome DevTools Protocol screencast API.
 * The user logs in to Facebook in their browser; no credentials touch the server.
 *
 * Uses SharedBrowser — acquires a tab in the shared Chrome instance rather
 * than launching its own browser. The browser stays alive after login so
 * poster and inbox can reuse it.
 *
 * Flow:
 *   1. start() — acquires shared browser, opens auth tab, navigates to fb login, streams
 *   2. Client sends mouse/keyboard events → sendInput() relays them to Puppeteer
 *   3. _checkForLogin() polls for the c_user + xs cookies that indicate success
 *   4. On success, cookies are encrypted and saved; onStatusChange fires 'success'
 *   5. Auth tab is released (browser stays alive for poster/inbox)
 */

const fs = require('fs');
const path = require('path');
const { encryptCookies } = require('./fb-crypto');
const { SESSIONS_DIR, ensureDirs } = require('./paths');
const { SharedBrowser, VIEWPORT } = require('./shared-browser');

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class FbAuthSession {
  constructor(options = {}) {
    this.salespersonId = options.salespersonId || 'default';
    this.sessionFile = path.join(SESSIONS_DIR, `${this.salespersonId}_fb_session.json`);

    this.page = null;
    this.cdpSession = null;
    this.status = 'idle'; // idle | starting | waiting_login | success | error

    /** Called with each JPEG frame as a base64 string */
    this.onFrame = null;
    /** Called with { state, message } on status changes */
    this.onStatusChange = null;

    this._timeout = null;
    this._loginCheckInterval = null;
    this._destroyed = false;
  }

  _setStatus(state, message = '') {
    this.status = state;
    console.log(`[fb-auth] [${this.salespersonId}] ${state}: ${message}`);
    if (this.onStatusChange) {
      this.onStatusChange({ state, message });
    }
  }

  async start() {
    ensureDirs();

    this._setStatus('starting', 'Launching browser...');

    // Acquire shared browser and get an auth tab
    await SharedBrowser.acquire(this.salespersonId);
    SharedBrowser.setAuthActive(this.salespersonId, true);

    this.page = await SharedBrowser.getPage(this.salespersonId, 'auth');
    await this.page.setViewport(VIEWPORT);

    // Start CDP screencast
    this.cdpSession = await this.page.createCDPSession();
    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
    });

    this.cdpSession.on('Page.screencastFrame', async ({ data, sessionId }) => {
      // Acknowledge frame immediately so Chrome sends the next one
      try {
        await this.cdpSession.send('Page.screencastFrameAck', { sessionId });
      } catch (_) {}
      if (this.onFrame && !this._destroyed) {
        this.onFrame(data);
      }
    });

    // Navigate to Facebook login
    await this.page.goto('https://www.facebook.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    this._setStatus('waiting_login', 'Please log in to Facebook');

    // Poll cookies every 2 seconds to detect successful login
    this._loginCheckInterval = setInterval(() => this._checkForLogin(), 2000);

    // Hard timeout — destroy after 5 minutes regardless
    this._timeout = setTimeout(() => {
      this._setStatus('error', 'Login timed out after 5 minutes');
      this.destroy();
    }, SESSION_TIMEOUT_MS);
  }

  async _checkForLogin() {
    if (!this.page || this._destroyed) return;
    try {
      const cookies = await this.page.cookies();
      const hasCUser = cookies.some(c => c.name === 'c_user');
      const hasXs = cookies.some(c => c.name === 'xs');
      if (hasCUser && hasXs) {
        this._clearTimers();
        await this._saveSession(cookies);
        this._setStatus('success', 'Login successful — session saved');
        // Allow time for the status message to reach the WebSocket client
        setTimeout(() => this.destroy(), 1500);
      }
    } catch (_) {
      // Page might be mid-navigation — ignore and retry on next tick
    }
  }

  async _saveSession(cookies) {
    const encrypted = encryptCookies(cookies);
    const sessionData = {
      ...encrypted,
      savedAt: new Date().toISOString(),
      validatedAt: new Date().toISOString(),
      salespersonId: this.salespersonId,
    };
    fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2));
    console.log(`[fb-auth] Session saved to ${this.sessionFile}`);
  }

  /**
   * Relay a client input event to the Puppeteer page.
   * Coordinates must already be in Puppeteer viewport space (1366×768).
   */
  async sendInput(event) {
    if (!this.page || this.status !== 'waiting_login' || this._destroyed) return;
    try {
      switch (event.type) {
        case 'mousemove':
          await this.page.mouse.move(event.x, event.y);
          break;
        case 'mousedown':
          await this.page.mouse.move(event.x, event.y);
          await this.page.mouse.down({ button: event.button || 'left' });
          break;
        case 'mouseup':
          await this.page.mouse.up({ button: event.button || 'left' });
          break;
        case 'click':
          await this.page.mouse.click(event.x, event.y, { button: event.button || 'left' });
          break;
        case 'keydown': {
          const key = event.key;
          if (!key) break;
          // Printable single characters — type them
          if (key.length === 1) {
            await this.page.keyboard.type(key);
          } else {
            // Special keys
            const specialKeys = {
              Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
              Delete: 'Delete', Escape: 'Escape', Space: 'Space',
              ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
              ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
              Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
              ' ': 'Space',
            };
            const mapped = specialKeys[key];
            if (mapped) await this.page.keyboard.press(mapped);
          }
          break;
        }
        case 'wheel':
          await this.page.mouse.wheel({
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
          });
          break;
      }
    } catch (_) {
      // Ignore — page may be navigating
    }
  }

  getStatus() {
    return { state: this.status, salespersonId: this.salespersonId };
  }

  _clearTimers() {
    if (this._loginCheckInterval) {
      clearInterval(this._loginCheckInterval);
      this._loginCheckInterval = null;
    }
    if (this._timeout) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._clearTimers();

    // Stop screencast and detach CDP session
    if (this.cdpSession) {
      this.cdpSession.send('Page.stopScreencast').catch(() => {});
      this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }

    // Release the auth page — do NOT close the browser
    SharedBrowser.releasePage(this.salespersonId, 'auth').catch(() => {});
    SharedBrowser.setAuthActive(this.salespersonId, false);
    this.page = null;
  }
}

module.exports = { FbAuthSession };
