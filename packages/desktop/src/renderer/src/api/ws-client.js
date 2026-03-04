const RECONNECT_DELAY = 5000;

export class WsClient {
  constructor() {
    this.ws = null;
    this.url = null;
    this.token = null;
    this.listeners = new Map();
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  connect(serverUrl, accessToken) {
    this._intentionalClose = false;
    const wsUrl = serverUrl.replace(/^http/, 'ws');
    this.url = `${wsUrl}/ws/dashboard?token=${encodeURIComponent(accessToken)}`;
    this.token = accessToken;
    this._doConnect();
  }

  _doConnect() {
    if (this.ws) {
      this.ws.close();
    }

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this._emit('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._emit(msg.type, msg);
        this._emit('message', msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this._emit('disconnected');
      if (!this._intentionalClose) {
        this._reconnectTimer = setTimeout(() => this._doConnect(), RECONNECT_DELAY);
      }
    };

    this.ws.onerror = () => {};
  }

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }
}

export const wsClient = new WsClient();
