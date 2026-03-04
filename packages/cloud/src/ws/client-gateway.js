'use strict';

const WebSocket = require('ws');
const { verifyAccessToken } = require('../middleware/auth');

class ClientGateway {
  constructor() {
    this.wss = new WebSocket.Server({ noServer: true });
    this.orgClients = new Map();

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || this._extractBearerToken(req);
    const decoded = verifyAccessToken(token);

    if (!decoded || !decoded.orgId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    req.user = decoded;
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
  }

  _onConnection(ws, req) {
    const orgId = req.user.orgId;

    if (!this.orgClients.has(orgId)) {
      this.orgClients.set(orgId, new Set());
    }
    this.orgClients.get(orgId).add(ws);

    ws.on('close', () => {
      const clients = this.orgClients.get(orgId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) this.orgClients.delete(orgId);
      }
    });

    ws.on('error', () => {});
  }

  broadcast(orgId, message) {
    const clients = this.orgClients.get(orgId);
    if (!clients) return;
    const payload = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  _extractBearerToken(req) {
    const auth = req.headers?.authorization;
    if (typeof auth !== 'string') return null;
    const [scheme, token] = auth.split(' ');
    return scheme === 'Bearer' ? token : null;
  }
}

module.exports = { ClientGateway };
