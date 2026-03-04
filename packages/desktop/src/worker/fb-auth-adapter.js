'use strict';

const EventEmitter = require('events');
const path = require('path');
const { Commands } = require('@autolander/shared/protocol');

class FbAuthAdapter extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.sessionDir = path.join(dataDir, 'sessions');
  }

  async execute(command, payload, { sendProgress }) {
    switch (command) {
      case Commands.LOGIN_FB:
        return this.startLogin(sendProgress);
      case Commands.GET_FB_STATUS:
        return this.getStatus();
      default:
        throw new Error(`FbAuthAdapter: unknown command ${command}`);
    }
  }

  async startLogin(sendProgress) {
    const FbAuthSession = require('../../lib/fb-auth-session');

    sendProgress?.('init', 'Starting Facebook login...', 10);

    const auth = new FbAuthSession({
      sessionDir: this.sessionDir,
    });

    auth.on('frame', (data) => this.emit('frame', data));
    auth.on('progress', (data) => this.emit('progress', data));

    try {
      sendProgress?.('login', 'Waiting for user to log in...', 30);
      const result = await auth.startInteractiveLogin();
      sendProgress?.('complete', 'Login successful!', 100);
      return result;
    } finally {
      await auth.close().catch(() => {});
    }
  }

  async getStatus() {
    try {
      const { FbSessionManager } = require('../../lib/fb-session-manager');
      const manager = new FbSessionManager({ dataDir: this.dataDir });
      return manager.getStatus();
    } catch {
      return { loggedIn: false, valid: false };
    }
  }
}

module.exports = { FbAuthAdapter };
