'use strict';

const WebSocket = require('ws');
const { verifyAccessToken } = require('../middleware/auth');
const { MessageTypes } = require('@autolander/shared/protocol');

class AgentGateway {
  constructor({ prisma, dashboardGateway }) {
    this.prisma = prisma;
    this.dashboardGateway = dashboardGateway;
    this.wss = new WebSocket.Server({ noServer: true });
    this.connections = new Map();

    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this._startHeartbeatCheck();
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

    req.user = {
      id: decoded.sub,
      username: decoded.username,
      role: decoded.role,
      orgId: decoded.orgId,
    };

    this.wss.handleUpgrade(req, socket, head, ws => {
      this.wss.emit('connection', ws, req);
    });
  }

  async _onConnection(ws, req) {
    const { user } = req;
    const key = `${user.orgId}:${user.id}`;

    console.log(`[agent-gw] Agent connected: ${user.username} (${key})`);

    const existing = this.connections.get(key);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close(1000, 'Replaced by new connection');
    }

    this.connections.set(key, { ws, user, orgId: user.orgId, lastPing: Date.now() });

    await this.prisma.agentConnection.upsert({
      where: { orgId_userId: { orgId: user.orgId, userId: user.id } },
      create: { orgId: user.orgId, userId: user.id, status: 'ONLINE', connectedAt: new Date() },
      update: { status: 'ONLINE', connectedAt: new Date(), disconnectedAt: null },
    }).catch(e => console.error('[agent-gw] DB upsert error:', e.message));

    this.dashboardGateway?.broadcast(user.orgId, {
      type: MessageTypes.AGENT_STATUS,
      agentId: user.id,
      username: user.username,
      status: 'ONLINE',
    });

    ws.on('message', (data) => this._onMessage(key, data));
    ws.on('close', () => this._onClose(key));
    ws.on('error', (err) => console.error(`[agent-gw] Error for ${key}:`, err.message));
  }

  _onMessage(key, raw) {
    try {
      const msg = JSON.parse(raw.toString());
      const conn = this.connections.get(key);
      if (!conn) return;

      switch (msg.type) {
        case MessageTypes.PING:
          this._handlePing(key, conn, msg);
          break;
        case MessageTypes.COMMAND_RESULT:
        case MessageTypes.PROGRESS:
        case MessageTypes.STREAM_FRAME:
          this._emitCommandResponse(conn, msg);
          break;
        case MessageTypes.STATUS_UPDATE:
          this._handleStatusUpdate(key, conn, msg);
          break;
        default:
          console.warn(`[agent-gw] Unknown message type from ${key}:`, msg.type);
      }
    } catch (e) {
      console.error(`[agent-gw] Bad message from ${key}:`, e.message);
    }
  }

  async _handlePing(key, conn, msg) {
    conn.lastPing = Date.now();

    await this.prisma.agentConnection.updateMany({
      where: { orgId: conn.orgId, userId: conn.user.id },
      data: {
        lastHeartbeat: new Date(),
        fbSessionValid: msg.fbSessionValid ?? false,
        fbSessionExpiry: msg.fbSessionExpiry ? new Date(msg.fbSessionExpiry) : null,
      },
    }).catch(() => {});
  }

  async _handleStatusUpdate(key, conn, msg) {
    await this.prisma.agentConnection.updateMany({
      where: { orgId: conn.orgId, userId: conn.user.id },
      data: { fbSessionValid: msg.fbSessionValid ?? false },
    }).catch(() => {});

    this.dashboardGateway?.broadcast(conn.orgId, {
      type: MessageTypes.AGENT_STATUS,
      agentId: conn.user.id,
      fbSessionValid: msg.fbSessionValid,
      reason: msg.reason,
    });
  }

  async _onClose(key) {
    const conn = this.connections.get(key);
    if (!conn) return;

    console.log(`[agent-gw] Agent disconnected: ${conn.user.username} (${key})`);
    this.connections.delete(key);

    await this.prisma.agentConnection.updateMany({
      where: { orgId: conn.orgId, userId: conn.user.id },
      data: { status: 'OFFLINE', disconnectedAt: new Date() },
    }).catch(() => {});

    this.dashboardGateway?.broadcast(conn.orgId, {
      type: MessageTypes.AGENT_STATUS,
      agentId: conn.user.id,
      username: conn.user.username,
      status: 'OFFLINE',
    });
  }

  sendToAgent(orgId, userId, message) {
    const key = `${orgId}:${userId}`;
    const conn = this.connections.get(key);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    conn.ws.send(JSON.stringify(message));
    return true;
  }

  getOnlineAgents(orgId) {
    const agents = [];
    for (const [, conn] of this.connections) {
      if (conn.orgId === orgId && conn.ws.readyState === WebSocket.OPEN) {
        agents.push(conn.user);
      }
    }
    return agents;
  }

  _emitCommandResponse(conn, msg) {
    if (this._onCommandResponse) {
      this._onCommandResponse(conn, msg);
    }
  }

  onCommandResponse(handler) {
    this._onCommandResponse = handler;
  }

  _extractBearerToken(req) {
    const auth = req.headers?.authorization;
    if (typeof auth !== 'string') return null;
    const [scheme, token] = auth.split(' ');
    return scheme === 'Bearer' ? token : null;
  }

  _startHeartbeatCheck() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, conn] of this.connections) {
        if (conn.lastPing && now - conn.lastPing > 60000) {
          console.log(`[agent-gw] Heartbeat timeout for ${key}`);
          conn.ws.close(1000, 'Heartbeat timeout');
        }
      }
    }, 30000);
  }
}

module.exports = { AgentGateway };
