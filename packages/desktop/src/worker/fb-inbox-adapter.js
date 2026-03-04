'use strict';

const EventEmitter = require('events');
const path = require('path');
const { Commands } = require('@autolander/shared/protocol');

class FbInboxAdapter extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.sessionDir = path.join(dataDir, 'sessions');
  }

  async execute(command, payload, { sendProgress }) {
    switch (command) {
      case Commands.CHECK_INBOX:
        return this.checkInbox(sendProgress);
      case Commands.SEND_MESSAGE:
        return this.sendMessage(payload.threadId, payload.text, payload.expectedBuyer, sendProgress);
      default:
        throw new Error(`FbInboxAdapter: unknown command ${command}`);
    }
  }

  async checkInbox(sendProgress) {
    const InboxMonitor = require('../../lib/inbox-monitor');

    sendProgress?.('init', 'Initializing inbox scan...', 10);

    const monitor = new InboxMonitor({
      sessionDir: this.sessionDir,
      headless: true,
    });

    try {
      sendProgress?.('scanning', 'Scanning inbox...', 30);
      const messages = await monitor.checkInbox();
      sendProgress?.('complete', `Found ${messages.length} messages`, 100);
      return { messages };
    } finally {
      await monitor.close().catch(() => {});
    }
  }

  async sendMessage(threadId, text, expectedBuyer, sendProgress) {
    const InboxMonitor = require('../../lib/inbox-monitor');

    const monitor = new InboxMonitor({
      sessionDir: this.sessionDir,
      headless: true,
    });

    try {
      sendProgress?.('sending', 'Sending message...', 50);
      await monitor.sendMessage(text, expectedBuyer);
      sendProgress?.('complete', 'Message sent', 100);
      return { sent: true };
    } finally {
      await monitor.close().catch(() => {});
    }
  }
}

module.exports = { FbInboxAdapter };
