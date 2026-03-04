'use strict';

const { HEARTBEAT_INTERVAL_MS } = require('@autolander/shared/constants');

class Heartbeat {
  constructor({ agentClient, getFbStatus }) {
    this.agentClient = agentClient;
    this.getFbStatus = getFbStatus;
    this._timer = null;
  }

  start() {
    this._timer = setInterval(async () => {
      try {
        const fbStatus = await this.getFbStatus();
        this.agentClient.setFbSessionValid(fbStatus?.valid || false);
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Heartbeat };
