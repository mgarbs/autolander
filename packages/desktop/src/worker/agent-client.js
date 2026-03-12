'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const Store = require('electron-store');
const { MessageTypes } = require('@autolander/shared/protocol');
const { HEARTBEAT_INTERVAL_MS, WS_PATHS } = require('@autolander/shared/constants');

const RECONNECT_DELAY_MS = 30000;
const AGENT_CAPABILITIES = ['fb_post', 'fb_inbox', 'fb_auth'];
const OFFLINE_QUEUE_MAX = 500;
const OFFLINE_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

class AgentClient extends EventEmitter {
  constructor({ serverUrl, accessToken, dataDir } = {}) {
    super();
    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
    this.dataDir = dataDir;
    this.agentId = this._deriveAgentId(accessToken);
    this.ws = null;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._connected = false;
    this._fbSessionValid = false;
    this._fbBrowserReady = false;
    this._store = new Store({ name: 'agent-queue' });
    const persistedQueue = this._store.get('queue', []);
    this._offlineQueue = Array.isArray(persistedQueue) ? persistedQueue : [];
  }

  async connect(serverUrl, accessToken) {
    if (typeof serverUrl === 'string' && serverUrl.length > 0) {
      this.serverUrl = serverUrl;
    }
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      this.accessToken = accessToken;
      this.agentId = this._deriveAgentId(accessToken);
    }
    if (!this.serverUrl || !this.accessToken) {
      throw new Error('AgentClient.connect requires serverUrl and accessToken');
    }

    const hasActiveSocket = this.ws && (
      this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING
    );
    if (hasActiveSocket) {
      this.disconnect();
    }

    this._intentionalClose = false;
    clearTimeout(this._reconnectTimer);

    this._doConnect();
  }

  _doConnect() {
    if (!this.serverUrl || !this.accessToken) return;

    const wsUrl = this.serverUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}${WS_PATHS.AGENT}?token=${encodeURIComponent(this.accessToken)}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this._connected = true;
      this._startHeartbeat();
      this.send({
        type: 'AGENT_HELLO',
        agentId: this.agentId,
        capabilities: AGENT_CAPABILITIES,
      });
      this._flushOfflineQueue();
      this.emit('status', this.getStatus());
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {}
    });

    this.ws.on('close', () => {
      this._connected = false;
      this._stopHeartbeat();
      this.emit('status', this.getStatus());

      if (!this._intentionalClose) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this._doConnect(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', () => {});
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimer);
    this._persistOfflineQueue();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    this._enqueueOffline(message);
  }

  getStatus() {
    return {
      connected: this._connected,
      fbSessionValid: this._fbSessionValid,
      fbBrowserReady: this._fbBrowserReady,
      queuedMessages: this._offlineQueue.length,
    };
  }

  setFbSessionValid(valid) {
    const nextValid = !!valid;
    this._fbSessionValid = nextValid;
    this.send({
      type: MessageTypes.STATUS_UPDATE,
      fbSessionValid: nextValid,
    });
    this.emit('status', this.getStatus());
  }

  setFbBrowserReady(ready) {
    this._fbBrowserReady = !!ready;
    this.emit('status', this.getStatus());
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case MessageTypes.COMMAND:
      case 'COMMAND':
        this.emit('command', msg);
        break;
      default:
        this.emit('message', msg);
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.send({
        type: MessageTypes.PING,
        fbSessionValid: this._fbSessionValid,
        fbBrowserReady: this._fbBrowserReady,
        timestamp: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _persistOfflineQueue() {
    this._store.set('queue', this._offlineQueue);
  }

  _enqueueOffline(message) {
    this._offlineQueue.push({
      ...message,
      queuedAt: Date.now(),
    });

    if (this._offlineQueue.length > OFFLINE_QUEUE_MAX) {
      this._offlineQueue.splice(0, this._offlineQueue.length - OFFLINE_QUEUE_MAX);
    }

    this._persistOfflineQueue();
    this.emit('status', this.getStatus());
  }

  _flushOfflineQueue() {
    if (this.ws?.readyState !== WebSocket.OPEN || this._offlineQueue.length === 0) return;

    const now = Date.now();
    const queue = this._offlineQueue;
    let sentCount = 0;
    let skippedCount = 0;

    for (const queuedMessage of queue) {
      const queuedAt = Number(queuedMessage?.queuedAt);
      if (!queuedAt || now - queuedAt > OFFLINE_MESSAGE_TTL_MS) {
        skippedCount += 1;
        continue;
      }

      const { queuedAt: _queuedAt, ...message } = queuedMessage;
      this.ws.send(JSON.stringify(message));
      sentCount += 1;
    }

    this._offlineQueue = [];
    this._persistOfflineQueue();
    this.emit('status', this.getStatus());
    console.log(`[agent-client] Flushed ${sentCount} queued messages`);
    console.log(`[agent-client] Skipped ${skippedCount} expired queued messages`);
  }

  _deriveAgentId(accessToken) {
    if (!accessToken) return 'desktop-agent';

    try {
      const parts = accessToken.split('.');
      if (parts.length < 2) return 'desktop-agent';
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      return json?.sub || json?.userId || json?.id || 'desktop-agent';
    } catch {
      return 'desktop-agent';
    }
  }
}

module.exports = { AgentClient };
