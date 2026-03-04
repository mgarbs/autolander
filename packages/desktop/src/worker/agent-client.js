'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const { MessageTypes } = require('@autolander/shared/protocol');
const { HEARTBEAT_INTERVAL_MS, RECONNECT_DELAY_MS, WS_PATHS } = require('@autolander/shared/constants');

class AgentClient extends EventEmitter {
  constructor({ serverUrl, accessToken, dataDir }) {
    super();
    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
    this.dataDir = dataDir;
    this.ws = null;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this._connected = false;
    this._fbSessionValid = false;
  }

  async connect() {
    this._intentionalClose = false;
    this._doConnect();
  }

  _doConnect() {
    const wsUrl = this.serverUrl.replace(/^http/, 'ws');
    const url = `${wsUrl}${WS_PATHS.AGENT}?token=${encodeURIComponent(this.accessToken)}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this._connected = true;
      this._startHeartbeat();
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
        this._reconnectTimer = setTimeout(() => this._doConnect(), RECONNECT_DELAY_MS);
      }
    });

    this.ws.on('error', () => {});
  }

  disconnect() {
    this._intentionalClose = true;
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  getStatus() {
    return {
      connected: this._connected,
      fbSessionValid: this._fbSessionValid,
    };
  }

  setFbSessionValid(valid) {
    this._fbSessionValid = valid;
    this.send({
      type: MessageTypes.STATUS_UPDATE,
      fbSessionValid: valid,
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case MessageTypes.COMMAND:
        this.emit('command', msg);
        break;
      default:
        this.emit('message', msg);
    }
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this.send({
        type: MessageTypes.PING,
        fbSessionValid: this._fbSessionValid,
        timestamp: Date.now(),
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
  }
}

module.exports = { AgentClient };
