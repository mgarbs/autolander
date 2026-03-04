'use strict';

const { Commands, MessageTypes } = require('@autolander/shared/protocol');

class CommandRouter {
  constructor({ agentClient, fbPosterAdapter, fbInboxAdapter, fbAuthAdapter }) {
    this.agentClient = agentClient;
    this.adapters = {
      [Commands.POST_VEHICLE]: fbPosterAdapter,
      [Commands.CHECK_INBOX]: fbInboxAdapter,
      [Commands.LOGIN_FB]: fbAuthAdapter,
      [Commands.ASSISTED_POST]: fbPosterAdapter,
      [Commands.SEND_MESSAGE]: fbInboxAdapter,
      [Commands.GET_FB_STATUS]: fbAuthAdapter,
    };

    agentClient.on('command', (msg) => this._handleCommand(msg));
  }

  async _handleCommand(msg) {
    const { commandId, command, payload } = msg;
    const adapter = this.adapters[command];

    if (!adapter) {
      this.agentClient.send({
        type: MessageTypes.COMMAND_RESULT,
        commandId,
        success: false,
        error: `Unknown command: ${command}`,
      });
      return;
    }

    try {
      const sendProgress = (stage, message, percent) => {
        this.agentClient.send({
          type: MessageTypes.PROGRESS,
          commandId,
          stage,
          message,
          percent,
        });
      };

      const result = await adapter.execute(command, payload, { sendProgress });

      this.agentClient.send({
        type: MessageTypes.COMMAND_RESULT,
        commandId,
        success: true,
        data: result,
      });
    } catch (err) {
      this.agentClient.send({
        type: MessageTypes.COMMAND_RESULT,
        commandId,
        success: false,
        error: err.message,
      });
    }
  }
}

module.exports = { CommandRouter };
