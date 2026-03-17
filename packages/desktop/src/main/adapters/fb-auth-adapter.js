'use strict';

class FbAuthAdapter {
  constructor({ dataDir, salespersonId = 'default', mainWindow = null } = {}) {
    this.dataDir = dataDir;
    this.salespersonId = salespersonId;
    this.mainWindow = mainWindow;
    this.activeSession = null;
  }

  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }

  setSalespersonId(id) {
    if (this.salespersonId === id) return;
    // Destroy active login session — it's using the old profile
    if (this.activeSession) {
      this.activeSession.destroy();
      this.activeSession = null;
    }
    this.salespersonId = id;
  }

  _send(channel, payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }

  async startLogin() {
    if (this.activeSession) {
      this.activeSession.destroy();
      this.activeSession = null;
    }

    const { FbAuthSession } = require('../../../lib/fb-auth-session');
    const session = new FbAuthSession({ salespersonId: this.salespersonId });

    session.onFrame = (frameData) => this._send('fb:frame', { data: frameData, width: 1366, height: 768 });
    session.onStatusChange = (s) => {
      this._send('fb:progress', {
        stage: s.state,
        status: s.state,
        message: s.message,
        percent: this._statusPercent(s.state),
      });
    };

    this.activeSession = session;
    await session.start();
    return session.getStatus();
  }

  async sendInput(input) {
    if (!this.activeSession) return { ok: false, message: 'No active auth session' };
    await this.activeSession.sendInput(input);
    return { ok: true };
  }

  getStatus() {
    const { FbSessionManager } = require('../../../lib/fb-session-manager');
    const manager = new FbSessionManager(this.salespersonId);
    return manager.getStatus();
  }

  deleteSession() {
    const { FbSessionManager } = require('../../../lib/fb-session-manager');
    const manager = new FbSessionManager(this.salespersonId);
    return { deleted: manager.deleteSession() };
  }

  destroy() {
    if (this.activeSession) {
      this.activeSession.destroy();
      this.activeSession = null;
    }
  }

  _statusPercent(state) {
    switch (state) {
      case 'starting':
        return 10;
      case 'waiting_login':
        return 40;
      case 'success':
        return 100;
      case 'error':
        return 100;
      default:
        return 0;
    }
  }
}

module.exports = { FbAuthAdapter };
