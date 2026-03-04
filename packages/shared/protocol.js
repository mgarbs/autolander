'use strict';

const crypto = require('crypto');

const Commands = {
  POST_VEHICLE: 'post_vehicle',
  CHECK_INBOX: 'check_inbox',
  LOGIN_FB: 'login_fb',
  ASSISTED_POST: 'assisted_post',
  SEND_MESSAGE: 'send_message',
  GET_FB_STATUS: 'get_fb_status',
};

const MessageTypes = {
  COMMAND: 'command',
  COMMAND_RESULT: 'command_result',
  PROGRESS: 'progress',
  STREAM_FRAME: 'stream_frame',
  PING: 'ping',
  STATUS_UPDATE: 'status_update',
  AGENT_STATUS: 'agent_status',
  POST_COMPLETE: 'post_complete',
  NEW_LEAD: 'new_lead',
  PROGRESS_UPDATE: 'progress_update',
  COMMAND_PROGRESS: 'command_progress',
  INVENTORY_UPDATED: 'inventory_updated',
  CONVERSATION_UPDATED: 'conversation_updated',
};

function createCommand(command, payload, timeout = 120000) {
  return {
    type: MessageTypes.COMMAND,
    commandId: crypto.randomUUID(),
    command,
    payload,
    timeout,
  };
}

module.exports = { Commands, MessageTypes, createCommand };
