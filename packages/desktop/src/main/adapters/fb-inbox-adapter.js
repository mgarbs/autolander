'use strict';

const { Commands } = require('@autolander/shared/protocol');
const { SharedBrowser } = require('../../../lib/shared-browser');

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

  async setSalespersonId(id) {
    if (this.salespersonId === id) return;
    // Release inbox page - shared browser teardown handled by ipc-handlers
    if (this.monitor) {
      await this.monitor.close().catch(() => {});
      this.monitor = null;
    }
    this.threadCache.clear();
    this.salespersonId = id;
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
    await this._getMonitor();
    const unlock = await SharedBrowser.lockNavigation(this.salespersonId, 'inbox');
    try {
      const monitor = await this._getMonitor();
      await monitor.navigateToInbox();

      const threads = await monitor.getThreadsFromGraphQL();
      console.log(`[fb-inbox] ${threads.length} threads from GraphQL`);

      const results = [];
      for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];
        if (!thread.realThreadId) {
          console.log(`[fb-inbox] Skipping ${thread.buyerName} - no thread ID`);
          continue;
        }

        const messages = await monitor.readThreadViaMessenger(thread);
        const vehicleMatch = monitor.parseVehicleFromText(thread.listingTitle) || null;
        const hydratedThread = {
          ...thread,
          messages,
          vehicleMatch,
          // Flag: the thread is CURRENTLY OPEN in the browser — sendMessage
          // can type directly without re-navigating
          _isOpen: (i === threads.length - 1),
        };
        results.push(hydratedThread);
      }

      if (results.length > 0) {
        results.forEach(thread => { thread._isOpen = false; });
        results[results.length - 1]._isOpen = true;
      }

      this.lastCheck = new Date().toISOString();
      return results;
    } finally {
      unlock();
    }
  }

  async sendMessage(threadId, text, expectedBuyer, listingTitle, { skipNavigation, realThreadId } = {}) {
    await this._getMonitor();
    const unlock = await SharedBrowser.lockNavigation(this.salespersonId, 'inbox');
    try {
      const monitor = await this._getMonitor();
      if (realThreadId) {
        const sent = await monitor.sendViaMessenger(realThreadId, text, expectedBuyer);
        return { sent };
      }

      if (!skipNavigation) {
        // Navigate to inbox and click the thread row to open it
        await monitor.navigateToInbox();
        await monitor.openThread({
          threadId,
          buyerName: expectedBuyer || '',
          listingTitle: listingTitle || '',
        });
      }

      const sent = await monitor.sendMessage(text, expectedBuyer || '');
      return { sent };
    } finally {
      unlock();
    }
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
      if (sendProgress) {
        sendProgress(result && result.sent === false ? 'failed' : 'sent', result && result.sent === false ? 'Reply failed' : 'Reply sent', 100);
      }
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
    if (this.monitor) {
      await this.monitor.close().catch(() => {});
      this.monitor = null;
    }
    this.threadCache.clear();
  }
}

module.exports = { FbInboxAdapter };
