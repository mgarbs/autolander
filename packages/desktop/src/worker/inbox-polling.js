'use strict';

const EventEmitter = require('events');

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
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
        this._paused = false;
        this._lastPoll = null;
        this._intervalNextAt = null;
        this._initialPollAt = null;
        this._messagesForwarded = 0;
        this.serverUrl = null;
        this.accessToken = null;
        // Track which buyer messages we've already responded to (GraphQL validation)
        // Key: threadId, Value: { fingerprint, respondedAt }
        this._respondedTo = new Map();
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
        this._paused = false;
        this._initialPollAt = null;
        this._intervalNextAt = null;
    }

    pause() {
        this._paused = true;
        // Stop the timers entirely — no polling, no browser activity
        clearTimeout(this._initialTimer);
        clearInterval(this._timer);
        this._initialTimer = null;
        this._timer = null;
        this._initialPollAt = null;
        this._intervalNextAt = null;
        console.log('[inbox-polling] Paused — polling stopped');
    }

    resume() {
        this._paused = false;
        // Restart the polling timer
        if (!this._timer && this._active) {
            this._timer = setInterval(() => {
                this._intervalNextAt = Date.now() + POLL_INTERVAL_MS;
                this._poll().catch((err) => {
                    console.error('[inbox-polling] Poll failed:', err.message);
                });
            }, POLL_INTERVAL_MS);
            this._intervalNextAt = Date.now() + POLL_INTERVAL_MS;
            // Do an immediate poll on resume
            this._poll().catch((err) => {
                console.error('[inbox-polling] Resume poll failed:', err.message);
            });
        }
        console.log('[inbox-polling] Resumed — polling restarted');
    }

    getStatus() {
        return {
            running: this._active,
            paused: this._paused,
            lastPoll: this._lastPoll,
            nextPoll: this._getNextPollTime(),
            messagesForwarded: this._messagesForwarded,
        };
    }

    async _poll() {
        if (this._paused) {
            console.log('[inbox-polling] Skipping poll (paused for posting)');
            return;
        }
        if (this._running) return;
        this._running = true;
        this._lastPoll = Date.now();
        const POLL_TIMEOUT = 180 * 1000;
        const timeoutId = setTimeout(() => {
            console.error('[inbox-polling] Poll timed out after 180s - forcing reset');
            this._running = false;
        }, POLL_TIMEOUT);

        try {
            // checkInbox opens ALL active threads sequentially and reads messages.
            // The LAST thread remains open in the browser.
            const result = await this.fbInboxAdapter.checkInbox();
            const threads = this._extractThreads(result);

            // Collect threads that need replies (buyer spoke last),
            // validated against GraphQL data to prevent duplicates.
            const needsReply = [];
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

                // GraphQL validation: fingerprint is the buyer's last message text only.
                // We don't include message count since our own replies or system messages
                // changing the count shouldn't trigger a new response.
                const lastBuyerText = (lastMsg.text || lastMsg.body || lastMsg.message || '').trim();
                const fingerprint = lastBuyerText.substring(0, 100);
                const prior = this._respondedTo.get(threadId);

                if (prior && prior.fingerprint === fingerprint) {
                    console.log(`[inbox-polling] ${thread.buyerName}: already responded to this state, skipping`);
                    continue;
                }

                thread._lastBuyerText = lastBuyerText;
                thread._fingerprint = fingerprint;
                needsReply.push(thread);
            }

            // Purge stale _respondedTo entries (older than 24h)
            const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
            for (const [tid, entry] of this._respondedTo) {
                if (entry.respondedAt < staleThreshold) this._respondedTo.delete(tid);
            }

            // Get responses from cloud for all threads that need replies
            for (const thread of needsReply) {
                const threadId = thread.threadId || thread.id;
                console.log(`[inbox-polling] ${thread.buyerName}: buyer spoke last, requesting response...`);

                const response = await this._getResponse(threadId, thread, thread.messages);

                if (response?.reply) {
                    console.log(`[inbox-polling] ${thread.buyerName}: sending reply (${response.reply.length} chars)`);
                    try {
                        // For the last thread opened by checkInbox, the chat is still
                        // visible — skip re-navigation. For others, navigate to inbox first.
                        const skipNav = Boolean(thread._isOpen);
                        const sendResult = await this.fbInboxAdapter.sendMessage(
                            threadId,
                            response.reply,
                            thread.buyerName,
                            thread.listingTitle,
                            { skipNavigation: skipNav, realThreadId: thread.realThreadId || thread._realFbId }
                        );

                        // Check the actual result — sendMessage returns { sent: boolean }
                        if (sendResult && sendResult.sent === false) {
                            console.error(`[inbox-polling] ${thread.buyerName}: sendMessage returned sent=false, retrying...`);
                            // Retry once with full navigation
                            const retry = await this.fbInboxAdapter.sendMessage(
                                threadId,
                                response.reply,
                                thread.buyerName,
                                thread.listingTitle,
                                { skipNavigation: false, realThreadId: thread.realThreadId || thread._realFbId }
                            );
                            if (!retry || retry.sent === false) {
                                console.error(`[inbox-polling] ${thread.buyerName}: retry also failed, skipping`);
                                continue;
                            }
                        }

                        console.log(`[inbox-polling] ${thread.buyerName}: reply sent to FB`);
                        this._messagesForwarded += 1;

                        // Record that we responded to this conversation state
                        this._respondedTo.set(threadId, {
                            fingerprint: thread._fingerprint,
                            respondedAt: Date.now(),
                        });

                        // Save the message to DB only AFTER FB send confirmed.
                        await this._saveSent(response.conversationId, response.reply);
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
            lastBuyerMessageText: (thread._lastBuyerText || '').substring(0, 200),
            messages: messages.map(m => ({
                text: m.text || m.body || m.message || '',
                isBuyer: Boolean(m.isBuyer),
                timestamp: m.timestamp || '',
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
                return { reply: result.reply, conversationId: result.conversationId };
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

    async _saveSent(conversationId, text) {
        if (!this.serverUrl || !this.accessToken || !conversationId || !text) return;
        try {
            const endpoint = new URL(
                `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
                this.serverUrl
            ).toString();
            await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    direction: 'OUTBOUND',
                    text,
                    intent: 'auto_reply',
                    status: 'SENT',
                }),
            });
            console.log(`[inbox-polling] Saved sent message for conv ${conversationId}`);
        } catch (err) {
            console.error(`[inbox-polling] Failed to save sent message: ${err.message}`);
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
