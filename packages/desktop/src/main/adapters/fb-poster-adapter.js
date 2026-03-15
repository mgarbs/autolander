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
