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

      const allThreads = await monitor.getThreadsFromGraphQL();

      // Filter threads:
      // - Must have a real FB thread ID
      // - Must have a known buyer name
      // - Must have recent activity (timestamp within last 7 days) — filters dead/old threads
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const threads = allThreads.filter(t => {
        if (!t.realThreadId) return false;
        if (!t.buyerName || t.buyerName === 'Unknown') {
          console.log(`[fb-inbox] Skip ${t.realThreadId?.slice(-6) || '?'} — unknown buyer`);
          return false;
        }
        // Filter by timestamp if available (GraphQL returns ms or seconds since epoch)
        if (t.timestamp) {
          let ts = parseInt(t.timestamp, 10);
          if (ts && ts < 1e12) ts *= 1000; // convert seconds to ms
          if (ts && (now - ts) > SEVEN_DAYS_MS) {
            console.log(`[fb-inbox] Skip ${t.buyerName} — last activity ${Math.round((now - ts) / 86400000)}d ago`);
            return false;
          }
        }
        return true;
      });
      console.log(`[fb-inbox] ${allThreads.length} total → ${threads.length} active (last 7 days)`);

      const results = [];
      for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];

        try {
          const messages = await monitor.readThreadViaMessenger(thread);

          // If Messenger showed "content not available", skip this thread
          const contentUnavailable = await monitor.page.evaluate(() => {
            return document.body?.textContent?.includes('isn\'t available right now') || false;
          }).catch(() => false);
          if (contentUnavailable) {
            console.log(`[fb-inbox] ${thread.buyerName} — content not available, stopping (remaining threads are older)`);
            break;
          }

          const vehicleMatch = monitor.parseVehicleFromText(thread.listingTitle) || null;
          const hydratedThread = {
            ...thread,
            messages,
            vehicleMatch,
            _isOpen: (i === threads.length - 1),
          };
          results.push(hydratedThread);
        } catch (err) {
          // Threads are sorted newest-first. If one times out, the rest are older
          // and will also timeout. Stop processing to save time.
          console.warn(`[fb-inbox] ${thread.buyerName} failed (${err.message}) — assuming remaining ${threads.length - i - 1} threads are older, stopping`);
          break;
        }
      }

      if (results.length > 0) {
        results.forEach(thread => { thread._isOpen = false; });
        results[results.length - 1]._isOpen = true;
      }

      this.lastCheck = new Date().toISOString();
      return results;
    } catch (err) {
      // If checkInbox fails (timeout, browser hung), kill the browser
      // so the next poll gets a fresh one instead of hitting the same dead browser
      console.error(`[fb-inbox] checkInbox failed: ${err.message} — resetting browser`);
      if (this.monitor) {
        await this.monitor.close().catch(() => {});
        this.monitor = null;
      }
      throw err;
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
