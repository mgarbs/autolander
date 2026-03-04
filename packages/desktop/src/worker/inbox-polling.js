'use strict';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

class InboxPolling {
  constructor({ fbInboxAdapter, onMessages }) {
    this.fbInboxAdapter = fbInboxAdapter;
    this.onMessages = onMessages;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    // Initial poll after 30 seconds
    setTimeout(() => this._poll(), 30000);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    if (this._running) return;
    this._running = true;

    try {
      const result = await this.fbInboxAdapter.checkInbox();
      if (result?.messages?.length > 0 && this.onMessages) {
        this.onMessages(result.messages);
      }
    } catch (err) {
      console.error('[inbox-polling] Error:', err.message);
    } finally {
      this._running = false;
    }
  }
}

module.exports = { InboxPolling };
