'use strict';

const { Commands } = require('@autolander/shared/protocol');

class FbInboxAdapter {
  constructor({ dataDir, salespersonId = 'default', mainWindow = null } = {}) {
    this.dataDir = dataDir;
    this.salespersonId = salespersonId;
    this.mainWindow = mainWindow;
    this.monitor = null;
    this.lastCheck = null;
    this.threadCache = new Map();
    this._sendQueue = Promise.resolve();
  }

  setMainWindow(mainWindow) {
    this.mainWindow = mainWindow;
  }

  async _getMonitor() {
    if (this.monitor && this.monitor.isAlive()) return this.monitor;
    if (this.monitor) {
      console.log('[fb-inbox] Browser died - reinitializing...');
      await this.monitor.close().catch(() => {});
      this.monitor = null;
    }
    const { InboxMonitor } = require('../../../lib/inbox-monitor');
    this.monitor = new InboxMonitor({ salespersonId: this.salespersonId });
    await this.monitor.init();
    return this.monitor;
  }

  async checkInbox() {
    const monitor = await this._getMonitor();
    await monitor.navigateToInbox();

    const threads = await monitor.getUnreadThreads();
    const results = [];
    this.threadCache.clear();

    for (const thread of threads) {
      this.threadCache.set(thread.threadId, thread);
      const messages = await monitor.openThread(thread);
      const vehicleMatch = monitor.parseVehicleFromText(thread.listingTitle) || null;
      results.push({
        threadId: thread.threadId,
        buyerName: thread.buyerName,
        listingTitle: thread.listingTitle || '',
        messages,
        vehicleMatch,
      });
    }

    this.lastCheck = new Date().toISOString();
    return results;
  }

  async sendMessage(threadId, text, expectedBuyer, listingTitle) {
    const monitor = await this._getMonitor();
    await monitor.navigateToInbox();

    // 1. Check cache first
    let thread = this.threadCache.get(threadId);

    // 2. Try unread threads
    if (!thread) {
      const unreadThreads = await monitor.getUnreadThreads();
      for (const t of unreadThreads) {
        this.threadCache.set(t.threadId, t);
      }
      thread = this.threadCache.get(threadId);
    }

    // 3. Try ALL visible threads (not just unread)
    if (!thread) {
      const allThreads = await monitor.getAllThreads ? await monitor.getAllThreads() : [];
      for (const t of allThreads) {
        this.threadCache.set(t.threadId, t);
      }
      thread = this.threadCache.get(threadId);
    }

    // 4. Last resort: construct a minimal thread object and try to open by ID
    if (!thread) {
      console.warn(`[fb-inbox] Thread ${threadId} not found in lists, attempting direct open`);
      thread = { threadId, buyerName: expectedBuyer || '', listingTitle: listingTitle || '' };
    }

    const buyerName = expectedBuyer || thread.buyerName;
    const resolvedListingTitle = listingTitle || thread.listingTitle || '';

    await monitor.openThread({ ...thread, buyerName, listingTitle: resolvedListingTitle });
    const sent = await monitor.sendMessage(text, buyerName);
    return { sent };
  }

  async execute(command, payload = {}, opts = {}) {
    // Serialize execute calls to prevent concurrent browser actions (garbled sends).
    const task = this._sendQueue.then(() => this._executeImpl(command, payload, opts));
    this._sendQueue = task.catch(() => {});
    return task;
  }

  async _executeImpl(command, payload = {}, { sendProgress } = {}) {
    if (command === Commands.SEND_MESSAGE || command === 'SEND_MESSAGE' || command === 'send_message') {
      const { threadId, text, expectedBuyer, listingTitle } = payload;
      if (!threadId || !text) {
        throw new Error('SEND_MESSAGE requires threadId and text');
      }
      if (sendProgress) sendProgress('sending', `Sending reply to ${expectedBuyer || 'buyer'}...`, 50);
      const result = await this.sendMessage(threadId, text, expectedBuyer, listingTitle);
      if (sendProgress) sendProgress('sent', 'Reply sent', 100);
      return result;
    }

    if (command === Commands.CHECK_INBOX || command === 'CHECK_INBOX' || command === 'check_inbox') {
      if (sendProgress) sendProgress('checking', 'Checking inbox...', 50);
      const result = await this.checkInbox();
      if (sendProgress) sendProgress('done', 'Inbox checked', 100);
      return result;
    }

    throw new Error(`FbInboxAdapter: unknown command ${command}`);
  }

  getStatus() {
    return {
      monitoring: !!this.monitor,
      lastCheck: this.lastCheck,
    };
  }

  isReady() {
    return !!this.monitor;
  }

  async destroy() {
    if (!this.monitor) return;
    await this.monitor.close().catch(() => {});
    this.monitor = null;
    this.threadCache.clear();
  }
}

module.exports = { FbInboxAdapter };
