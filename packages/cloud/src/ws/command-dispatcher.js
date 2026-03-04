'use strict';

const { createCommand, MessageTypes } = require('@autolander/shared/protocol');

class CommandDispatcher {
  constructor({ agentGateway, dashboardGateway, prisma }) {
    this.agentGateway = agentGateway;
    this.dashboardGateway = dashboardGateway;
    this.prisma = prisma;
    this.pending = new Map();

    this.agentGateway.onCommandResponse((conn, msg) => this._handleResponse(conn, msg));
  }

  dispatch(orgId, agentUserId, command, payload, opts = {}) {
    const timeout = opts.timeout || 120000;
    const msg = createCommand(command, payload, timeout);

    const sent = this.agentGateway.sendToAgent(orgId, agentUserId, msg);
    if (!sent) {
      return Promise.reject(new Error('Agent is not connected.'));
    }

    this.prisma.activityLog.create({
      data: { orgId, userId: agentUserId, action: `command:${command}`, details: { commandId: msg.commandId } },
    }).catch(() => {});

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.commandId);
        reject(new Error(`Command ${command} timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(msg.commandId, {
        resolve, reject, orgId, timer,
        onProgress: opts.onProgress,
      });
    });
  }

  async pickAgent(orgId) {
    const agent = await this.prisma.agentConnection.findFirst({
      where: { orgId, status: 'ONLINE', fbSessionValid: true },
      select: { userId: true },
    });
    if (agent) return agent.userId;

    const fallback = await this.prisma.agentConnection.findFirst({
      where: { orgId, status: 'ONLINE' },
      select: { userId: true },
    });
    return fallback?.userId || null;
  }

  _handleResponse(conn, msg) {
    const entry = this.pending.get(msg.commandId);
    if (!entry) return;

    switch (msg.type) {
      case MessageTypes.COMMAND_RESULT:
        clearTimeout(entry.timer);
        this.pending.delete(msg.commandId);
        if (msg.success) {
          entry.resolve(msg.data);
        } else {
          entry.reject(new Error(msg.error || 'Command failed'));
        }
        this.dashboardGateway.broadcast(entry.orgId, {
          type: MessageTypes.POST_COMPLETE,
          commandId: msg.commandId,
          success: msg.success,
          data: msg.data,
        });
        break;

      case MessageTypes.PROGRESS:
        if (entry.onProgress) entry.onProgress(msg);
        this.dashboardGateway.broadcast(entry.orgId, {
          type: MessageTypes.COMMAND_PROGRESS,
          commandId: msg.commandId,
          stage: msg.stage,
          message: msg.message,
          percent: msg.percent,
        });
        break;

      case MessageTypes.STREAM_FRAME:
        this.dashboardGateway.broadcast(entry.orgId, {
          type: MessageTypes.STREAM_FRAME,
          commandId: msg.commandId,
          data: msg.data,
        });
        break;
    }
  }
}

module.exports = { CommandDispatcher };
