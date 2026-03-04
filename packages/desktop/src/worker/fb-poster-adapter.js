'use strict';

const EventEmitter = require('events');
const path = require('path');
const { Commands } = require('@autolander/shared/protocol');

class FbPosterAdapter extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.sessionDir = path.join(dataDir, 'sessions');
  }

  async execute(command, payload, { sendProgress }) {
    switch (command) {
      case Commands.POST_VEHICLE:
        return this.postVehicle(payload.vehicle, payload.listing, sendProgress);
      case Commands.ASSISTED_POST:
        return this.startAssistedPost(payload.vehicle, sendProgress);
      default:
        throw new Error(`FbPosterAdapter: unknown command ${command}`);
    }
  }

  async postVehicle(vehicle, listing, sendProgress) {
    const FacebookPoster = require('../../lib/facebook-poster');

    sendProgress?.('init', 'Initializing browser...', 10);

    const poster = new FacebookPoster({
      sessionDir: this.sessionDir,
      headless: true,
    });

    try {
      sendProgress?.('posting', 'Posting to Facebook Marketplace...', 30);
      const result = await poster.postVehicle(vehicle, listing);
      sendProgress?.('complete', 'Posted successfully!', 100);
      return result;
    } finally {
      await poster.close().catch(() => {});
    }
  }

  async startAssistedPost(vehicle, sendProgress) {
    const AssistedPostSession = require('../../lib/assisted-post-session');

    sendProgress?.('init', 'Starting assisted post session...', 10);

    const session = new AssistedPostSession({
      sessionDir: this.sessionDir,
    });

    session.on('frame', (data) => this.emit('frame', data));
    session.on('progress', (data) => this.emit('progress', data));

    return session.start(vehicle);
  }
}

module.exports = { FbPosterAdapter };
