/**
 * Assisted Post Session
 *
 * Orchestrates a human-in-the-loop FB Marketplace posting flow:
 *   1. AI fills the form automatically (photos, vehicle details, description)
 *   2. Browser viewport is streamed to the user via CDP screencast
 *   3. User reviews the filled form, then manually clicks "Next" and "Publish"
 *
 * This eliminates bot-detection signals on the critical submission clicks by
 * ensuring real human mouse events (with natural trajectories and timing)
 * are used for the final publish action.
 *
 * Uses FacebookPoster for form filling and attaches a CDP screencast to the
 * same Puppeteer page — no separate browser launch.
 */

const path = require('path');
const fs = require('fs');
const { FacebookPoster } = require('./facebook-poster');
const { DATA_DIR, ensureDirs } = require('./paths');

const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
ensureDirs();
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const VIEWPORT = { width: 1366, height: 768 };
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for user to review + publish
const PUBLISH_POLL_MS = 2000;

class AssistedPostSession {
  constructor(options = {}) {
    this.salespersonId = options.salespersonId || 'default';
    this.vehicle = options.vehicle;

    this.poster = null;
    this.cdpSession = null;
    this.status = 'idle';
    this._destroyed = false;
    this._timeout = null;
    this._publishDetectInterval = null;
    this._resultDetail = null;

    /** Called with each JPEG frame as a base64 string */
    this.onFrame = null;
    /** Called with { state, message, detail? } on status changes */
    this.onStatusChange = null;
  }

  _setStatus(state, message = '', detail = null) {
    this.status = state;
    if (detail) this._resultDetail = detail;
    console.log(`[assisted-post] [${this.salespersonId}] ${state}: ${message}`);
    if (this.onStatusChange) {
      this.onStatusChange({ state, message, detail });
    }
  }

  async start() {
    try {
      // Phase 1: Initialize poster and connect to Chrome
      this._setStatus('initializing', 'Connecting to browser...');

      this.poster = new FacebookPoster({
        salespersonId: this.salespersonId,
      });
      await this.poster.init();

      // When connected to existing Chrome, it skips loadSession() assuming the
      // browser is already logged in. But the FB auth flow runs in a separate
      // Puppeteer instance, so the existing Chrome may not have those cookies.
      // Always load saved session cookies to ensure we're authenticated.
      if (this.poster.isConnected) {
        await this.poster.loadSession();
      }

      // Lock viewport to match screencast dimensions so click coordinates align.
      // Without this, Chrome's actual viewport (e.g. 1920x1080) differs from the
      // screencast frame size (1366x768), making every click land off-target.
      await this.poster.page.setViewport(VIEWPORT);

      // Verify we're actually logged in before proceeding
      const loggedIn = await this.poster.checkLoginStatus();
      if (!loggedIn) {
        throw new Error('Not logged into Facebook. Please authenticate first via Settings > Facebook Auth.');
      }

      // Attach CDP screencast to the poster's page for live streaming
      await this._startScreencast();

      // Phase 2: Navigate to the create listing form
      this._setStatus('navigating', 'Opening Marketplace listing form...');
      await this.poster.goToCreateListing(this.vehicle);

      // Phase 3: Upload photos
      const photos = this._discoverPhotos();
      if (photos.length > 0) {
        this._setStatus('uploading_photos', `Uploading ${photos.length} photo(s)...`);
        await this.poster.uploadPhotos(photos);
      }

      // Phase 4: Fill form fields
      this._setStatus('filling_form', 'AI is filling the vehicle details...');
      await this.poster.fillVehicleForm(this.vehicle);

      // Scroll to top so user sees the completed form
      await this.poster.page.evaluate(() => window.scrollTo(0, 0));

      // Phase 5: Hand over to the user
      this._setStatus('awaiting_review',
        'Form filled! Review the listing and click "Next" when ready.');

      // Start polling for page transitions (user clicks Next, then Publish)
      this._startPublishDetection();

      // Hard timeout — 10 minutes for user to complete
      this._timeout = setTimeout(() => {
        if (!this._destroyed && this.status !== 'success') {
          this._setStatus('timeout', 'Session timed out. The listing was not published.');
          this.destroy();
        }
      }, SESSION_TIMEOUT_MS);

    } catch (e) {
      console.error('[assisted-post] start() error:', e.message);
      this._setStatus('error', `Failed: ${e.message}`);
      this.destroy();
    }
  }

  /**
   * Discover photo files for the vehicle from data/photos/{vin}/
   */
  _discoverPhotos() {
    // Use photos already on the vehicle object if present
    if (this.vehicle.photos && this.vehicle.photos.length > 0) {
      return this.vehicle.photos;
    }

    const vin = this.vehicle.vin;
    if (!vin) return [];

    const photosDir = path.join(PHOTOS_DIR, vin);
    if (!fs.existsSync(photosDir)) return [];

    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    return fs.readdirSync(photosDir)
      .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
      .sort()
      .map(f => path.join(photosDir, f));
  }

  /**
   * Attach CDP screencast to the poster's existing Puppeteer page.
   * Streams JPEG frames via the onFrame callback.
   */
  async _startScreencast() {
    const page = this.poster.page;
    this.cdpSession = await page.createCDPSession();

    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
    });

    this.cdpSession.on('Page.screencastFrame', async ({ data, sessionId }) => {
      try {
        await this.cdpSession.send('Page.screencastFrameAck', { sessionId });
      } catch (_) {}
      if (this.onFrame && !this._destroyed) {
        this.onFrame(data);
      }
    });
  }

  /**
   * Relay a client input event to the Puppeteer page.
   * Only active during interactive states (awaiting_review, awaiting_publish).
   */
  async sendInput(event) {
    const interactiveStates = ['awaiting_review', 'awaiting_publish'];
    if (!this.poster?.page || !interactiveStates.includes(this.status) || this._destroyed) {
      return;
    }

    try {
      const page = this.poster.page;
      switch (event.type) {
        case 'mousemove':
          await page.mouse.move(event.x, event.y);
          break;
        case 'mousedown':
          await page.mouse.move(event.x, event.y);
          await page.mouse.down({ button: event.button || 'left' });
          break;
        case 'mouseup':
          await page.mouse.up({ button: event.button || 'left' });
          break;
        case 'click':
          await page.mouse.click(event.x, event.y, { button: event.button || 'left' });
          break;
        case 'keydown': {
          const key = event.key;
          if (!key) break;
          if (key.length === 1) {
            await page.keyboard.type(key);
          } else {
            const specialKeys = {
              Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
              Delete: 'Delete', Escape: 'Escape', Space: 'Space',
              ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
              ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
              Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
              ' ': 'Space',
            };
            const mapped = specialKeys[key];
            if (mapped) await page.keyboard.press(mapped);
          }
          break;
        }
        case 'wheel':
          await page.mouse.wheel({
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
          });
          break;
      }
    } catch (_) {
      // Page may be navigating
    }
  }

  /**
   * Poll the page to detect state transitions:
   *   awaiting_review → awaiting_publish (user clicked Next)
   *   awaiting_publish → success (URL changed to /item/ or /marketplace/you/)
   */
  _startPublishDetection() {
    this._publishDetectInterval = setInterval(async () => {
      if (this._destroyed || !this.poster?.page) return;

      try {
        const pageState = await this.poster.page.evaluate(() => {
          const url = window.location.href;
          // Get visible button text to detect page phase
          const buttons = Array.from(document.querySelectorAll('[role="button"]'));
          const buttonTexts = buttons
            .map(b => (b.textContent || '').trim().toLowerCase())
            .filter(t => t.length < 30);
          return { url, buttonTexts };
        });

        // Detect: user clicked Next → now on review/publish page
        if (this.status === 'awaiting_review' &&
            pageState.buttonTexts.includes('publish') &&
            !pageState.buttonTexts.includes('next')) {
          this._setStatus('awaiting_publish',
            'On review page. Click "Publish" to list your vehicle.');
        }

        // Detect: publish complete (URL changed to item page)
        if ((this.status === 'awaiting_publish') &&
            (pageState.url.includes('/item/') || pageState.url.includes('/marketplace/you/'))) {
          const postIdMatch = pageState.url.match(/\/item\/(\d+)/);
          const postId = postIdMatch ? postIdMatch[1] : null;
          this._setStatus('success', 'Listing published successfully!', {
            postUrl: pageState.url,
            postId,
            postedAt: new Date().toISOString(),
          });
          this._clearTimers();
        }

        // Detect: FB "temporarily blocked" error
        if (pageState.buttonTexts.some(t => t.includes('temporarily blocked'))) {
          this._setStatus('error', 'Facebook has temporarily blocked posting. Try again later.');
          this.destroy();
        }
      } catch (_) {
        // Page may be navigating — retry on next tick
      }
    }, PUBLISH_POLL_MS);
  }

  /**
   * Return current session result for the REST status endpoint.
   */
  getResult() {
    return {
      status: this.status,
      vehicle: this.vehicle ? {
        vin: this.vehicle.vin,
        year: this.vehicle.year,
        make: this.vehicle.make,
        model: this.vehicle.model,
      } : null,
      ...(this._resultDetail || {}),
    };
  }

  _clearTimers() {
    if (this._publishDetectInterval) {
      clearInterval(this._publishDetectInterval);
      this._publishDetectInterval = null;
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

    if (this.cdpSession) {
      this.cdpSession.send('Page.stopScreencast').catch(() => {});
      this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }

    if (this.poster) {
      this.poster.close().catch(() => {});
      this.poster = null;
    }
  }
}

module.exports = { AssistedPostSession };
