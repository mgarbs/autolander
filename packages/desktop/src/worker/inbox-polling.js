'use strict';

const EventEmitter = require('events');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_POLL_DELAY_MS = 15 * 1000; // 15 seconds

class InboxPolling extends EventEmitter {
    constructor({ fbInboxAdapter, onMessages } = {}) {
        super();
        this.fbInboxAdapter = fbInboxAdapter;
        this.onMessages = onMessages;
        this._timer = null;
        this._initialTimer = null;
        this._running = false;
        this._active = false;
        this._lastPoll = null;
        this._intervalNextAt = null;
        this._initialPollAt = null;
        this._messagesForwarded = 0;
        this.serverUrl = null;
        this.accessToken = null;
    }

    start(fbInboxAdapter, { serverUrl, accessToken } = {}) {
        if (this._active) return;

        if (fbInboxAdapter) this.fbInboxAdapter = fbInboxAdapter;
        if (serverUrl) this.serverUrl = serverUrl;
        if (accessToken) this.accessToken = accessToken;

        if (!this.fbInboxAdapter) {
            throw new Error('InboxPolling.start() requires fbInboxAdapter');
        }

        this._active = true;

        const now = Date.now();
        this._initialPollAt = now + INITIAL_POLL_DELAY_MS;
        this._intervalNextAt = now + POLL_INTERVAL_MS;

        this._initialTimer = setTimeout(() => {
            this._initialTimer = null;
            this._initialPollAt = null;
            this._poll().catch((err) => {
                console.error('[inbox-polling] Initial poll failed:', err.message);
            });
        }, INITIAL_POLL_DELAY_MS);

        this._timer = setInterval(() => {
            this._intervalNextAt = Date.now() + POLL_INTERVAL_MS;
            this._poll().catch((err) => {
                console.error('[inbox-polling] Poll failed:', err.message);
            });
        }, POLL_INTERVAL_MS);
    }

    stop() {
        clearTimeout(this._initialTimer);
        clearInterval(this._timer);
        this._initialTimer = null;
        this._timer = null;
        this._active = false;
        this._initialPollAt = null;
        this._intervalNextAt = null;
    }

    getStatus() {
        return {
            running: this._active,
            lastPoll: this._lastPoll,
            nextPoll: this._getNextPollTime(),
            messagesForwarded: this._messagesForwarded,
        };
    }

    async _poll() {
        if (this._running) return;
        this._running = true;
        this._lastPoll = Date.now();
        const POLL_TIMEOUT = 180 * 1000;
        const timeoutId = setTimeout(() => {
            console.error('[inbox-polling] Poll timed out after 180s - forcing reset');
            this._running = false;
        }, POLL_TIMEOUT);

        try {
            const result = await this.fbInboxAdapter.checkInbox();
            const threads = this._extractThreads(result);

            for (const thread of threads) {
                const threadId = thread?.threadId || thread?.id;
                if (!threadId) continue;

                const messages = Array.isArray(thread?.messages) ? thread.messages : [];
                if (messages.length === 0) continue;

                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || !lastMsg.isBuyer) {
                    console.log(`[inbox-polling] ${thread.buyerName}: last message is ours, skipping`);
                    continue;
                }

                console.log(`[inbox-polling] ${thread.buyerName}: buyer spoke last, requesting response...`);

                const response = await this._getResponse(threadId, thread, messages);

                if (response?.reply) {
                    console.log(`[inbox-polling] ${thread.buyerName}: sending reply (${response.reply.length} chars)`);
                    try {
                        await this.fbInboxAdapter.sendMessage(
                            threadId,
                            response.reply,
                            thread.buyerName,
                            thread.listingTitle
                        );
                        console.log(`[inbox-polling] ${thread.buyerName}: reply sent to FB`);
                        this._messagesForwarded += 1;

                        // Confirm delivery to cloud
                        if (response.messageId) {
                            await this._confirmSent(response.messageId);
                        }
                    } catch (err) {
                        console.error(`[inbox-polling] ${thread.buyerName}: send failed: ${err.message}`);
                    }
                }
            }

            if (threads.length > 0) {
                this.emit('poll-complete', { threadCount: threads.length });
            }
        } catch (err) {
            console.error('[inbox-polling] Error:', err.message);
            this.emit('poll-error', { error: err.message });
        } finally {
            clearTimeout(timeoutId);
            this._running = false;
        }
    }

    async _getResponse(threadId, thread, messages) {
        if (!this.serverUrl || !this.accessToken) {
            console.warn('[inbox-polling] Missing serverUrl or accessToken');
            return null;
        }

        const endpoint = new URL(
            `/api/conversations/${encodeURIComponent(threadId)}/respond`,
            this.serverUrl
        ).toString();

        const body = {
            buyerName: thread.buyerName || '',
            listingTitle: thread.listingTitle || '',
            messages: messages.map(m => ({
                text: m.text || m.body || m.message || '',
                isBuyer: Boolean(m.isBuyer),
            })).filter(m => m.text.trim()),
        };

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                let details = '';
                try { details = await response.text(); } catch {}
                console.error(`[inbox-polling] Respond failed for ${threadId}: HTTP ${response.status} ${details}`);
                return null;
            }

            const result = await response.json();
            if (result.reply) {
                return { reply: result.reply, messageId: result.messageId };
            }
            if (result.reason) {
                console.log(`[inbox-polling] ${thread.buyerName}: no reply (${result.reason})`);
            }
            return null;
        } catch (err) {
            console.error(`[inbox-polling] Respond error for ${threadId}:`, err.message);
            return null;
        }
    }

    async _confirmSent(messageId) {
        if (!this.serverUrl || !this.accessToken || !messageId) return;
        try {
            const endpoint = new URL(
                `/api/conversations/messages/${encodeURIComponent(messageId)}/confirm-sent`,
                this.serverUrl
            ).toString();
            await fetch(endpoint, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
            });
            console.log(`[inbox-polling] Confirmed delivery: ${messageId}`);
        } catch (err) {
            console.error(`[inbox-polling] Failed to confirm delivery: ${err.message}`);
        }
    }

    _extractThreads(result) {
        if (Array.isArray(result)) return result;
        if (Array.isArray(result?.threads)) return result.threads;
        if (Array.isArray(result?.conversations)) return result.conversations;

        if (Array.isArray(result?.messages)) {
            const grouped = new Map();
            for (const message of result.messages) {
                const threadId = message?.threadId || message?.conversationId;
                if (!threadId) continue;
                if (!grouped.has(threadId)) {
                    grouped.set(threadId, {
                        threadId,
                        buyerName: message?.buyerName || '',
                        vehicleId: message?.vehicleId || null,
                        messages: [],
                    });
                }
                grouped.get(threadId).messages.push(message);
            }
            return Array.from(grouped.values());
        }

        return [];
    }

    _getNextPollTime() {
        const candidates = [this._initialPollAt, this._intervalNextAt]
            .filter((v) => typeof v === 'number' && v > Date.now());
        if (candidates.length === 0) return null;
        return Math.min(...candidates);
    }
}

module.exports = { InboxPolling };
