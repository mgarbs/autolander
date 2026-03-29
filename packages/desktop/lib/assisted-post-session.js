/**
 * Assisted Post Session
 *
 * Orchestrates a human-in-the-loop FB Marketplace flow:
 *   1. AI fills the form automatically
 *   2. Browser viewport is streamed to the user via CDP screencast
 *   3. User reviews the filled form and completes the final action
 */

const path = require('path');
const fs = require('fs');
const { FacebookPoster } = require('./facebook-poster');
const { DATA_DIR, ensureDirs } = require('./paths');

const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
ensureDirs();
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const VIEWPORT = { width: 1366, height: 768 };
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for review + publish/save
const PUBLISH_POLL_MS = 2000;

class AssistedPostSession {
  constructor(options = {}) {
    this.salespersonId = options.salespersonId || 'default';
    this.vehicle = options.vehicle;
    this.apiUrl = options.apiUrl || '';
    this.authToken = options.authToken || '';
    this.editListingUrl = options.editListingUrl || null;
    this._editListingId = this._extractListingId(this.editListingUrl);

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

  log(message) {
    if (this.poster && typeof this.poster.log === 'function') {
      this.poster.log(message);
      return;
    }
    console.log(`[assisted-post] [${this.salespersonId}] ${message}`);
  }

  _setStatus(state, message = '', detail = null) {
    this.status = state;
    if (detail) this._resultDetail = detail;
    console.log(`[assisted-post] [${this.salespersonId}] ${state}: ${message}`);
    if (this.onStatusChange) {
      this.onStatusChange({ state, message, detail });
    }
  }

  _isEditMode() {
    return !!this.editListingUrl;
  }

  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _extractListingId(url) {
    if (!url) return null;

    const patterns = [
      /\/item\/(\d+)(?:\/|$|\?)/i,
      /\/edit\/(\d+)(?:\/|$|\?)/i,
      /\/(\d+)(?:\/|$|\?)/,
    ];

    for (const pattern of patterns) {
      const match = String(url).match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  _buildEditUrl(listingId) {
    return `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`;
  }

  _buildItemUrl(listingId) {
    return `https://www.facebook.com/marketplace/item/${listingId}/`;
  }

  _getStaleReasonKeys() {
    const rawReasons = this.vehicle?.listings?.facebook_marketplace?.staleReason
      || this.vehicle?.fbStaleReason
      || '';

    return new Set(
      String(rawReasons)
        .split(',')
        .map((reason) => reason.trim().split(':')[0])
        .filter(Boolean)
    );
  }

  async start() {
    try {
      this._setStatus('initializing', 'Connecting to browser...');

      this.poster = new FacebookPoster({
        salespersonId: this.salespersonId,
        apiUrl: this.apiUrl,
        authToken: this.authToken,
      });
      await this.poster.init();

      await this.poster.page.setViewport(VIEWPORT);

      const loggedIn = await this.poster.checkLoginStatus();
      if (!loggedIn) {
        throw new Error('Not logged into Facebook. Please authenticate first via Settings > Facebook Auth.');
      }

      // Restore browser window from minimized state AFTER login check
      // (which navigates to facebook.com). Must happen right before screencast
      // — minimized windows produce black frames on Mac.
      const { SharedBrowser } = require('./shared-browser');
      await SharedBrowser.restoreWindow(this.salespersonId);

      await this._startScreencast();

      const photos = this._discoverPhotos();
      await this._navigateToListingForm();

      if (this._isEditMode()) {
        await this._runEditFlow(photos);
      } else {
        if (photos.length > 0) {
          this._setStatus('uploading_photos', `Uploading ${photos.length} photo(s)...`);
          await this.poster.uploadPhotos(photos);
        }

        this._setStatus('filling_form', 'AI is filling the vehicle details...');
        await this.poster.fillVehicleForm(this.vehicle);
      }

      await this._scrollToActionArea();

      // Scroll to the action button so the user can see it
      await this.poster.page.evaluate(() => {
        // Look for Save, Next, Publish, Update buttons
        const buttons = document.querySelectorAll('[role="button"], button');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if ((text === 'save' || text === 'next' || text === 'publish' || text === 'update'
              || text === 'save draft' || text === 'update listing')
              && btn.offsetParent !== null) {
            btn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
          }
        }
        // Fallback: scroll to bottom
        window.scrollTo(0, document.body.scrollHeight);
      });
      await this._delay(500);

      if (this._isEditMode()) {
        this._setStatus('awaiting_publish', 'Listing updated. Review the changes and click "Save" when ready.');
      } else {
        this._setStatus('awaiting_review', 'Form filled! Review the listing and click "Next" when ready.');
      }

      this._startPublishDetection();

      this._timeout = setTimeout(() => {
        if (!this._destroyed && this.status !== 'success') {
          const timeoutMessage = this._isEditMode()
            ? 'Session timed out. The listing was not updated.'
            : 'Session timed out. The listing was not published.';
          this._setStatus('timeout', timeoutMessage);
          this.destroy();
        }
      }, SESSION_TIMEOUT_MS);
    } catch (e) {
      console.error('[assisted-post] start() error:', e.message);
      this._setStatus('error', `Failed: ${e.message}`);
      this.destroy();
    }
  }

  async _navigateToListingForm() {
    if (this._isEditMode()) {
      const listingId = this._editListingId || this._extractListingId(this.editListingUrl);

      if (listingId) {
        const targetUrl = this._buildEditUrl(listingId);
        this._editListingId = listingId;
        this.log(`Editing existing listing: ${targetUrl}`);

        this._setStatus('navigating', 'Opening Marketplace edit form...');
        await this.poster.page.goto(targetUrl, {
          waitUntil: 'networkidle2',
          timeout: 60000,
        });
        await this._delay(2500);
        await this.poster.takeScreenshot('debug_edit_listing_loaded');
        return;
      }

      // No listing ID — find the listing on the selling page by title + price
      const postedPrice = this.vehicle.listings?.facebook_marketplace?.postedPrice
        || this.vehicle.fbPostedPrice
        || this.vehicle.price;
      this.log(`No listing ID — searching selling page for "${this.vehicle.year} ${this.vehicle.make} ${this.vehicle.model}" at $${postedPrice}`);
      this._setStatus('navigating', 'Searching your listings for this vehicle...');

      await this.poster.page.goto('https://www.facebook.com/marketplace/you/dashboard', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });
      await this._delay(3000);

      // Scroll down to load more listings
      for (let i = 0; i < 3; i++) {
        await this.poster.page.evaluate(() => window.scrollBy(0, 1000));
        await this._delay(1000);
      }

      const searchTitle = `${this.vehicle.year} ${this.vehicle.make} ${this.vehicle.model}`.toLowerCase();
      const priceStr = postedPrice ? String(Math.round(postedPrice)) : null;
      const formattedPrice = postedPrice ? Number(Math.round(postedPrice)).toLocaleString() : null;

      // On the dashboard, listings are cards with span text — not links.
      // We need to: 1) find the card by title+price, 2) click it, 3) grab the edit link that appears.

      // Step 1: Click the matching listing card
      const clicked = await this.poster.page.evaluate((title, price, formatted) => {
        const spans = document.querySelectorAll('span');
        // Find the title span
        for (const span of spans) {
          if (span.textContent.trim().toLowerCase() !== title) continue;
          // Found the title — walk up to the card container
          let card = span;
          for (let i = 0; i < 10; i++) {
            card = card.parentElement;
            if (!card) break;
            const cardText = card.textContent || '';
            // Verify price is in this card (if we have one)
            if (price && !cardText.includes(price) && (!formatted || !cardText.includes(formatted))) continue;
            // Check if this looks like a listing card (has action buttons)
            if (cardText.includes('Mark as sold') || cardText.includes('Renew')) {
              // Click the title's clickable parent to open the detail panel
              const clickable = span.closest('[role="button"]');
              if (clickable) { clickable.click(); return true; }
            }
          }
        }
        return false;
      }, searchTitle, priceStr, formattedPrice);

      if (!clicked) {
        await this.poster.takeScreenshot('debug_edit_listing_not_found');
        throw new Error(
          `Could not find "${this.vehicle.year} ${this.vehicle.make} ${this.vehicle.model}" at $${postedPrice} on your dashboard. ` +
          'The listing may have been removed from Facebook.'
        );
      }

      // Step 2: Wait for the edit link to appear after clicking
      await this._delay(3000);

      // Step 3: Grab the edit link with listing_id
      const listingIdFromEdit = await this.poster.page.evaluate(() => {
        const editLink = document.querySelector('a[href*="/marketplace/edit/"]');
        if (!editLink) return null;
        const href = editLink.href || editLink.getAttribute('href');
        const match = href.match(/listing_id=(\d+)/);
        return match ? match[1] : null;
      });

      if (!listingIdFromEdit) {
        await this.poster.takeScreenshot('debug_edit_link_not_found');
        throw new Error(
          'Found the listing but could not get the edit link. Please try again.'
        );
      }

      this._editListingId = listingIdFromEdit;
      const editUrl = this._buildEditUrl(listingIdFromEdit);
      this.log(`Found listing ${listingIdFromEdit} via dashboard click, navigating to edit: ${editUrl}`);

      await this.poster.page.goto(editUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
      await this._delay(2500);
      await this.poster.takeScreenshot('debug_edit_listing_loaded');
      return;
    }

    this._setStatus('navigating', 'Opening Marketplace listing form...');
    await this.poster.goToCreateListing(this.vehicle);
  }

  async _runEditFlow(photos) {
    const staleReasonKeys = this._getStaleReasonKeys();
    const shouldUpdatePhotos = staleReasonKeys.has('photos_changed');
    const shouldUpdatePrice = staleReasonKeys.size === 0 || staleReasonKeys.has('price_changed');
    const shouldUpdateDescription = staleReasonKeys.size === 0 || staleReasonKeys.has('description_changed');

    await this.poster.dismissOverlays();

    if (shouldUpdatePhotos) {
      if (photos.length > 0) {
        this._setStatus('uploading_photos', `Updating ${photos.length} photo(s)...`);
        await this._replacePhotos(photos);
      } else {
        this.log('Photo update requested, but no photos were found for this vehicle.');
      }
    }

    this._setStatus('filling_form', 'AI is updating editable listing details...');

    if (shouldUpdatePrice && this.vehicle?.price !== undefined && this.vehicle?.price !== null) {
      await this._updateFieldValue(['Price'], this.vehicle.price.toString(), {
        fieldName: 'price',
        numeric: true,
      });
    }

    if (shouldUpdateDescription) {
      const description = await this._resolveDescription();
      if (description) {
        await this._updateFieldValue(['Description'], description, {
          fieldName: 'description',
          multiline: true,
          allowTextareaFallback: true,
        });
      }
    }

    await this.poster.takeScreenshot('debug_edit_form_complete');
  }

  async _replacePhotos(photos) {
    await this.poster.page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of document.querySelectorAll('[role="dialog"], [role="main"], form')) {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = 0;
        }
      }
    });
    await this._delay(500);

    const existingPhotoCount = await this._getPhotoCount();
    if (existingPhotoCount > 0) {
      const removedAny = await this._removeExistingPhotos();
      if (!removedAny) {
        this.log('Could not auto-remove existing photos on the edit page. Leaving photo changes for manual review.');
        return false;
      }
    }

    await this.poster.uploadPhotos(photos);
    await this.poster.takeScreenshot('debug_edit_photos_uploaded');
    return true;
  }

  async _getPhotoCount() {
    try {
      return await this.poster.page.evaluate(() => {
        const text = document.body.innerText || '';
        const match = text.match(/Photos?\s*\n?\s*[·:]\s*(\d+)/i);
        if (match) {
          return parseInt(match[1], 10);
        }

        return Array.from(document.querySelectorAll('form img, [role="dialog"] img, [role="main"] img'))
          .filter((img) => img.offsetParent !== null)
          .length;
      });
    } catch (_) {
      return 0;
    }
  }

  async _removeExistingPhotos() {
    let removedAny = false;

    for (let attempt = 0; attempt < 20; attempt++) {
      const removal = await this.poster.page.evaluate(() => {
        const normalize = (value) => String(value || '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();

        const buttons = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]'))
          .filter((el) => el.offsetParent !== null);

        for (const button of buttons) {
          const label = normalize(button.getAttribute('aria-label'));
          const text = normalize(button.textContent);
          const combined = `${label} ${text}`.trim();

          if (
            combined.includes('delete photo')
            || combined.includes('remove photo')
            || combined.includes('delete image')
            || combined.includes('remove image')
          ) {
            button.click();
            return { clicked: true, control: combined };
          }
        }

        return { clicked: false, control: null };
      });

      if (!removal.clicked) {
        break;
      }

      removedAny = true;
      this.log(`Removing existing photo using "${removal.control}".`);
      await this._delay(700);
      await this._confirmPhotoRemoval();
      await this._delay(1000);
    }

    return removedAny;
  }

  async _confirmPhotoRemoval() {
    const control = await this.poster.page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((dialog) => dialog.offsetParent !== null);

      for (const dialog of dialogs) {
        const buttons = dialog.querySelectorAll('[role="button"], button');
        for (const button of buttons) {
          const text = normalize(button.textContent);
          const label = normalize(button.getAttribute('aria-label'));
          const combined = `${label} ${text}`.trim();

          if (combined === 'delete' || combined === 'remove' || combined === 'confirm' || combined === 'yes') {
            button.click();
            return combined;
          }
        }
      }

      return null;
    });

    if (control) {
      this.log(`Confirmed photo removal with "${control}".`);
    }
  }

  async _resolveDescription() {
    let description = this.vehicle?.generatedDescription || this.vehicle?.generated_content?.description || null;

    if (!description) {
      description = await this.poster.generateDescription(this.vehicle);
    }

    if (!description) {
      description = this.vehicle?.description || '';
    }

    if (!description) {
      const price = this.vehicle?.price ? `$${Number(this.vehicle.price).toLocaleString()}` : 'Great price';
      const miles = this.vehicle?.mileage ? `${Number(this.vehicle.mileage).toLocaleString()} miles` : '';
      const parts = [
        `Clean ${this.vehicle?.year || ''} ${this.vehicle?.make || ''} ${this.vehicle?.model || ''}`.trim(),
        miles,
        price,
        'Financing available. Trade-ins welcome.',
        this.vehicle?.vin ? `VIN: ${this.vehicle.vin}` : '',
      ].filter(Boolean);
      description = parts.join('\n');
    }

    return String(description || '').trim();
  }

  async _findEditableField(labels, { allowTextareaFallback = false } = {}) {
    const candidates = Array.isArray(labels) ? labels : [labels];

    for (const label of candidates) {
      const field = await this.poster.findFieldByLabel(label);
      if (field) {
        return field;
      }
    }

    if (allowTextareaFallback) {
      return this.poster.page.$('textarea');
    }

    return null;
  }

  async _readFieldValue(field) {
    return field.evaluate((el) => {
      if (typeof el.value === 'string') {
        return el.value;
      }

      if (el.isContentEditable) {
        return el.innerText || el.textContent || '';
      }

      return el.textContent || '';
    });
  }

  _normalizeFieldValue(value, { numeric = false } = {}) {
    const text = String(value || '').trim();
    if (numeric) {
      return text.replace(/[^\d.]/g, '');
    }
    return text.replace(/\s+/g, ' ');
  }

  async _updateFieldValue(labels, value, options = {}) {
    const fieldName = options.fieldName || (Array.isArray(labels) ? labels[0] : labels);
    const nextValue = String(value || '').trim();
    if (!nextValue) {
      return false;
    }

    const field = await this._findEditableField(labels, options);
    if (!field) {
      this.log(`Skipping ${fieldName}: field not found on edit page.`);
      return false;
    }

    const currentValue = await this._readFieldValue(field);
    if (this._normalizeFieldValue(currentValue, options) === this._normalizeFieldValue(nextValue, options)) {
      this.log(`Leaving ${fieldName} unchanged; existing value already matches.`);
      return false;
    }

    await field.evaluate((el) => {
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') {
        el.focus();
      }
    });
    await this._delay(300);

    await field.click({ clickCount: 3 }).catch(async () => {
      await field.evaluate((el) => {
        if (typeof el.click === 'function') {
          el.click();
        }
      });
    });
    await this._delay(150);

    await this.poster.page.keyboard.down('Control');
    await this.poster.page.keyboard.press('A');
    await this.poster.page.keyboard.up('Control');
    await this._delay(100);
    await this.poster.page.keyboard.press('Backspace');
    await this._delay(100);
    await this.poster.page.keyboard.type(nextValue, {
      delay: options.multiline ? 10 : 20,
    });
    await this._delay(250);

    this.log(`Updated ${fieldName} on the edit page.`);
    return true;
  }

  async _scrollToActionArea() {
    await this.poster.page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      for (const el of document.querySelectorAll('[role="dialog"], [role="main"], form')) {
        if (el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
  }

  _isEditPage(url) {
    return /\/marketplace\/edit\/\d+\/?/i.test(url || '') || /\/item\/\d+\/edit\/?/i.test(url || '');
  }

  _buildSuccessDetail(pageState) {
    const postId = this._extractListingId(pageState.url) || this._editListingId || null;
    let postUrl = pageState.url.includes('/item/')
      ? pageState.url
      : (postId ? this._buildItemUrl(postId) : (this.editListingUrl || pageState.url));

    // Don't store the selling dashboard as the listing URL — it's useless for edits
    if (postUrl && (postUrl.includes('/marketplace/you') || postUrl.includes('/marketplace/create'))) {
      postUrl = postId ? this._buildItemUrl(postId) : null;
    }

    return {
      postUrl,
      postId,
      postedAt: new Date().toISOString(),
      updated: this._isEditMode(),
    };
  }

  _isEditSuccess(pageState) {
    const currentUrl = String(pageState.url || '').toLowerCase();
    if (currentUrl.includes('/marketplace/you/')) {
      return true;
    }

    if (currentUrl.includes('/item/') && !this._isEditPage(currentUrl)) {
      return true;
    }

    const feedbackText = `${pageState.statusText || ''} ${pageState.bodyText || ''}`.toLowerCase();
    return [
      'listing updated',
      'changes saved',
      'your changes were saved',
      'item updated',
      'saved changes',
    ].some((snippet) => feedbackText.includes(snippet));
  }

  /**
   * Discover photo files for the vehicle from data/photos/{vin}/
   */
  _discoverPhotos() {
    if (this.vehicle.photos && this.vehicle.photos.length > 0) {
      return this.vehicle.photos;
    }

    const vin = this.vehicle.vin;
    if (!vin) return [];

    const photosDir = path.join(PHOTOS_DIR, vin);
    if (!fs.existsSync(photosDir)) return [];

    const imageExts = ['.jpg', '.jpeg', '.png', '.webp'];
    return fs.readdirSync(photosDir)
      .filter((file) => imageExts.includes(path.extname(file).toLowerCase()))
      .sort()
      .map((file) => path.join(photosDir, file));
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
   * Only active during interactive states.
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
              Enter: 'Enter',
              Backspace: 'Backspace',
              Tab: 'Tab',
              Delete: 'Delete',
              Escape: 'Escape',
              Space: 'Space',
              ArrowLeft: 'ArrowLeft',
              ArrowRight: 'ArrowRight',
              ArrowUp: 'ArrowUp',
              ArrowDown: 'ArrowDown',
              Home: 'Home',
              End: 'End',
              PageUp: 'PageUp',
              PageDown: 'PageDown',
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
   * Poll the page to detect create/edit completion.
   */
  _startPublishDetection() {
    this._publishDetectInterval = setInterval(async () => {
      if (this._destroyed || !this.poster?.page) return;

      try {
        const pageState = await this.poster.page.evaluate(() => {
          const url = window.location.href;
          const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
          const buttonTexts = buttons
            .filter((button) => button.offsetParent !== null)
            .map((button) => (button.textContent || '').trim().toLowerCase())
            .filter((text) => text.length > 0 && text.length < 30);
          const statusText = Array.from(document.querySelectorAll('[aria-live], [role="alert"], [role="status"]'))
            .filter((el) => el.offsetParent !== null)
            .map((el) => (el.textContent || '').trim().toLowerCase())
            .filter(Boolean)
            .join(' ');
          const bodyText = (document.body.innerText || '').toLowerCase();

          return { url, buttonTexts, statusText, bodyText };
        });

        if (this._isEditMode()) {
          if (this.status === 'awaiting_publish' && this._isEditSuccess(pageState)) {
            if (this.poster) await this.poster.saveSession().catch(() => {});
            this._setStatus('success', 'Listing updated successfully!', this._buildSuccessDetail(pageState));
            this._clearTimers();
          }
        } else {
          if (
            this.status === 'awaiting_review'
            && pageState.buttonTexts.includes('publish')
            && !pageState.buttonTexts.includes('next')
          ) {
            this._setStatus('awaiting_publish', 'On review page. Click "Publish" to list your vehicle.');
          }

          if (
            this.status === 'awaiting_publish'
            && (pageState.url.includes('/item/') || pageState.url.includes('/marketplace/you/'))
          ) {
            // Wait for URL to settle to /item/{id} so we capture the permanent listing URL.
            // FB redirects through /marketplace/you/ first, then to /item/{id} after a few seconds.
            if (!pageState.url.includes('/item/')) {
              if (!this._waitingForFinalUrl) {
                this._waitingForFinalUrl = Date.now();
                this.log('Waiting for final listing URL to settle...');
              }
              // Give FB up to 15 seconds to redirect to /item/{id}
              if (Date.now() - this._waitingForFinalUrl < 15000) {
                return; // Keep polling
              }
              // Timeout — use whatever URL we have
              this.log('URL did not settle to /item/ — using current URL');
            }
            if (this.poster) await this.poster.saveSession().catch(() => {});
            this._setStatus('success', 'Listing published successfully!', this._buildSuccessDetail(pageState));
            this._clearTimers();
          }
        }

        if (
          pageState.buttonTexts.some((text) => text.includes('temporarily blocked'))
          || pageState.statusText.includes('temporarily blocked')
          || pageState.bodyText.includes('temporarily blocked')
        ) {
          this._setStatus('error', 'Facebook has temporarily blocked posting. Try again later.');
          this.destroy();
        }
      } catch (_) {
        // Page may be navigating; retry on next tick.
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
      // Save session cookies BEFORE closing — preserves the FB login
      // for the next post. Without this, cookies are lost and the user
      // gets "Not logged into Facebook" on the next attempt.
      this.poster.saveSession().catch(() => {});
      this.poster.close().catch(() => {});
      this.poster = null;
    }
  }
}

module.exports = { AssistedPostSession };
