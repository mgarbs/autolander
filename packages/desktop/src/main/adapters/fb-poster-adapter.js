'use strict';

class FbPosterAdapter {
  constructor({ dataDir, salespersonId = 'default', mainWindow = null, apiUrl = '', authToken = '' } = {}) {
    this.dataDir = dataDir;
    this.salespersonId = salespersonId;
    this.mainWindow = mainWindow;
    this.apiUrl = apiUrl;
    this.authToken = authToken;
    this.poster = null;
    this.assistedSession = null;
  }

  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }

  setApiCredentials(apiUrl = '', authToken = '') {
    this.apiUrl = apiUrl;
    this.authToken = authToken;
    if (this.poster && typeof this.poster.setCloudCredentials === 'function') {
      this.poster.setCloudCredentials(apiUrl, authToken);
    }
  }

  async setSalespersonId(id) {
    if (this.salespersonId === id) return;
    // Tear down cached Puppeteer — it holds the old user's session cookies
    this.cancelAssistedPost();
    if (this.poster) {
      await this.poster.close().catch(() => {});
      this.poster = null;
    }
    this.salespersonId = id;
  }

  _send(channel, payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }

  async _getPoster() {
    if (this.poster) return this.poster;
    const { FacebookPoster } = require('../../../lib/facebook-poster');
    this.poster = new FacebookPoster({
      salespersonId: this.salespersonId,
      apiUrl: this.apiUrl,
      authToken: this.authToken,
    });
    await this.poster.init();
    return this.poster;
  }

  async postVehicle(vehicleData) {
    this._send('fb:progress', {
      stage: 'initializing',
      message: 'Preparing Facebook poster session...',
      percent: 10,
    });

    const poster = await this._getPoster();

    this._send('fb:progress', {
      stage: 'posting',
      message: 'Posting vehicle to Marketplace...',
      percent: 40,
    });

    const result = await poster.postVehicle(vehicleData);

    this._send('fb:progress', {
      stage: result.success ? 'complete' : 'failed',
      message: result.success ? 'Vehicle post completed' : (result.error || 'Vehicle post failed'),
      percent: 100,
    });

    return result;
  }

  async startAssistedPost(vehicleData) {
    if (this.assistedSession) {
      this.assistedSession.destroy();
      this.assistedSession = null;
    }

    const { AssistedPostSession } = require('../../../lib/assisted-post-session');
    const session = new AssistedPostSession({
      salespersonId: this.salespersonId,
      vehicle: vehicleData,
      apiUrl: this.apiUrl,
      authToken: this.authToken,
    });

    session.onFrame = (frameData) => this._send('fb:frame', { data: frameData });
    session.onStatusChange = (status) => {
      this._send('fb:progress', {
        stage: status.state,
        message: status.message,
        percent: this._statusPercent(status.state),
        detail: status.detail || null,
      });

      if (status.state === 'success') {
        // Always mark as posted, then try to find the real listing URL
        this._markVehiclePostedAndFindUrl(vehicleData, status.detail || {}).catch((err) => {
          console.error('[fb-poster-adapter] Failed to mark vehicle as posted:', err.message);
        });
      }
    };

    this.assistedSession = session;
    // Fire-and-forget so the IPC call returns immediately and the renderer
    // can switch to the streaming view while the session runs in background.
    session.start().catch((err) => {
      console.error('[fb-poster-adapter] session.start() error:', err.message);
      // Send error to renderer so user sees it instead of a black screen
      this._send('fb:progress', {
        stage: 'error',
        message: err.message || 'Failed to start posting session',
        percent: 100,
      });
    });
    return { started: true };
  }

  async sendInput(input) {
    if (!this.assistedSession) return { ok: false, message: 'No active assisted post session' };
    await this.assistedSession.sendInput(input);
    return { ok: true };
  }

  cancelAssistedPost() {
    if (this.assistedSession) {
      this.assistedSession.destroy();
      this.assistedSession = null;
    }
    return { cancelled: true };
  }

  async startAssistedUpdate(vehicleData, listingUrl) {
    if (this.assistedSession) {
      this.assistedSession.destroy();
      this.assistedSession = null;
    }

    const { AssistedPostSession } = require('../../../lib/assisted-post-session');
    const session = new AssistedPostSession({
      salespersonId: this.salespersonId,
      vehicle: vehicleData,
      apiUrl: this.apiUrl,
      authToken: this.authToken,
      editListingUrl: listingUrl,
    });

    session.onFrame = (frameData) => this._send('fb:frame', { data: frameData });
    session.onStatusChange = (status) => {
      this._send('fb:progress', {
        stage: status.state,
        message: status.message,
        percent: this._statusPercent(status.state),
        detail: status.detail || null,
      });
    };

    this.assistedSession = session;
    session.start().catch((err) => {
      console.error('[fb-poster-adapter] update session error:', err.message);
      this._send('fb:progress', {
        stage: 'error',
        message: err.message || 'Failed to start update session',
        percent: 100,
      });
    });
    return { started: true };
  }

  async delistVehicle(listingUrl) {
    this._send('fb:progress', {
      stage: 'initializing',
      message: 'Preparing to mark listing as sold...',
      percent: 10,
    });

    const poster = await this._getPoster();

    this._send('fb:progress', {
      stage: 'delisting',
      message: 'Marking listing as sold on Facebook...',
      percent: 50,
    });

    const result = await poster.markListingAsSold(listingUrl);

    this._send('fb:progress', {
      stage: result.success ? 'complete' : 'failed',
      message: result.success ? 'Listing marked as sold' : 'Failed to mark as sold',
      percent: 100,
    });

    return result;
  }

  async renewListing(listingUrl) {
    this._send('fb:progress', {
      stage: 'initializing',
      message: 'Preparing to renew listing...',
      percent: 10,
    });

    const poster = await this._getPoster();

    this._send('fb:progress', {
      stage: 'renewing',
      message: 'Renewing listing on Facebook...',
      percent: 50,
    });

    const result = await poster.renewListing(listingUrl);

    this._send('fb:progress', {
      stage: result.success ? 'complete' : 'failed',
      message: result.success ? 'Listing renewed' : 'Failed to renew listing',
      percent: 100,
    });

    return result;
  }

  async _markVehiclePostedAndFindUrl(vehicle, detail) {
    if (!this.apiUrl || !this.authToken || !vehicle?.id) return;

    // Step 1: Mark as posted immediately (even without URL)
    let fbListingUrl = detail.postUrl || null;
    let fbListingId = detail.postId || null;

    try {
      const url = `${this.apiUrl}/api/vehicles/${vehicle.id}/mark-posted`;
      await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fbListingUrl, fbListingId }),
      });
      console.log(`[fb-poster-adapter] Marked vehicle ${vehicle.id} as posted`);
    } catch (err) {
      console.error('[fb-poster-adapter] mark-posted failed:', err.message);
    }

    // Step 2: If we don't have a real listing URL, try to find it
    // by navigating to the selling page and matching by title
    if (!fbListingId && this.assistedSession?.poster?.page) {
      try {
        const page = this.assistedSession.poster.page;
        const title = `${vehicle.year} ${vehicle.make} ${vehicle.model}`.toLowerCase();
        console.log(`[fb-poster-adapter] Searching selling page for "${title}"...`);

        await page.goto('https://www.facebook.com/marketplace/you/selling', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await new Promise(r => setTimeout(r, 3000));

        // Scrape listing links from the selling page
        const found = await page.evaluate((searchTitle) => {
          const links = document.querySelectorAll('a[href*="/item/"]');
          for (const link of links) {
            const text = (link.textContent || '').toLowerCase();
            if (text.includes(searchTitle)) {
              const href = link.href || link.getAttribute('href');
              const match = href.match(/\/item\/(\d+)/);
              if (match) {
                return { listingId: match[1], listingUrl: `https://www.facebook.com/marketplace/item/${match[1]}/` };
              }
            }
          }
          return null;
        }, title);

        if (found) {
          fbListingUrl = found.listingUrl;
          fbListingId = found.listingId;
          console.log(`[fb-poster-adapter] Found listing URL: ${fbListingUrl}`);

          // Update the vehicle with the real URL
          try {
            const url = `${this.apiUrl}/api/vehicles/${vehicle.id}/mark-posted`;
            await fetch(url, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${this.authToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ fbListingUrl, fbListingId }),
            });
            console.log(`[fb-poster-adapter] Updated listing URL for ${vehicle.id}`);
          } catch (err) {
            console.error('[fb-poster-adapter] URL update failed:', err.message);
          }
        } else {
          console.log('[fb-poster-adapter] Could not find listing on selling page');
        }
      } catch (err) {
        console.error('[fb-poster-adapter] Selling page scrape failed:', err.message);
      }
    }
  }

  async destroy() {
    this.cancelAssistedPost();
    if (this.poster) {
      await this.poster.close().catch(() => {});
      this.poster = null;
    }
  }

  _statusPercent(state) {
    switch (state) {
      case 'initializing':
        return 10;
      case 'navigating':
        return 25;
      case 'uploading_photos':
        return 45;
      case 'filling_form':
        return 65;
      case 'awaiting_review':
        return 80;
      case 'awaiting_publish':
        return 90;
      case 'success':
        return 100;
      case 'error':
      case 'timeout':
        return 100;
      default:
        return 0;
    }
  }
}

module.exports = { FbPosterAdapter };
