'use strict';

const EventEmitter = require('events');

const WATCHDOG_INTERVAL_MS = 30 * 1000;
const DEBOUNCE_MS = 3000;
const INBOX_URL = 'https://www.facebook.com/marketplace/inbox/';
const MESSENGER_FALLBACK = 'https://www.facebook.com/messages/t/';

class InboxListener extends EventEmitter {
    constructor({ fbInboxAdapter } = {}) {
        super();
        this.fbInboxAdapter = fbInboxAdapter;
        this._active = false;
        this._paused = false;
        this._processing = false;
        this._lastMessage = null;
        this._messagesForwarded = 0;
        this.serverUrl = null;
        this.accessToken = null;
        // Same fingerprint map as InboxPolling
        this._respondedTo = new Map();
        this._watchdogTimer = null;
        this._pendingThreads = [];
    }

    start(fbInboxAdapter, { serverUrl, accessToken } = {}) {
        if (this._active) return;
        if (fbInboxAdapter) this.fbInboxAdapter = fbInboxAdapter;
        if (serverUrl) this.serverUrl = serverUrl;
        if (accessToken) this.accessToken = accessToken;
        if (!this.fbInboxAdapter) throw new Error('InboxListener requires fbInboxAdapter');

        this._active = true;
        this._paused = false;
        console.log('[inbox-listener] Starting passive listener');

        this._startListening().catch(err => {
            console.error('[inbox-listener] Failed to start:', err.message);
        });
    }

    stop() {
        this._active = false;
        this._paused = false;
        this._stopListening();
        console.log('[inbox-listener] Stopped');
    }

    pause() {
        this._paused = true;
        this._stopListening();
        console.log('[inbox-listener] Paused - listener stopped');
    }

    resume() {
        this._paused = false;
        if (this._active) {
            console.log('[inbox-listener] Resumed - restarting listener');
            this._startListening().catch(err => {
                console.error('[inbox-listener] Failed to resume:', err.message);
            });
        }
    }

    getStatus() {
        return {
            running: this._active,
            paused: this._paused,
            lastMessage: this._lastMessage,
            messagesForwarded: this._messagesForwarded,
            mode: 'listener',
        };
    }

    async _startListening() {
        try {
            // Navigate to inbox
            const monitor = await this.fbInboxAdapter._getMonitor();

            // Try marketplace inbox first, fall back to messenger
            try {
                await monitor._goto(INBOX_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            } catch {
                console.log('[inbox-listener] Marketplace inbox failed, trying Messenger');
                await monitor._goto(MESSENGER_FALLBACK, { waitUntil: 'networkidle2', timeout: 30000 });
            }

            await new Promise(r => setTimeout(r, 2000));

            // Inject the MutationObserver
            await this._injectObserver();

            // Start watchdog
            this._watchdogTimer = setInterval(() => {
                this._watchdogCheck().catch(err => {
                    console.warn('[inbox-listener] Watchdog error:', err.message);
                });
            }, WATCHDOG_INTERVAL_MS);

            console.log('[inbox-listener] Parked on inbox, observer active');
        } catch (err) {
            console.error('[inbox-listener] Start listening failed:', err.message);
        }
    }

    _stopListening() {
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = null;
        }
        // Try to disconnect the observer
        this._disconnectObserver().catch(() => {});
    }

    async _injectObserver() {
        const monitor = await this.fbInboxAdapter._getMonitor();
        const page = monitor.page;
        if (!page || page.isClosed()) return;

        // Expose callback function from page to Node
        try {
            await page.exposeFunction('__autolanderNewMessage', (data) => {
                this._onNewMessage(data);
            });
        } catch {
            // Already exposed from a previous injection - that's fine
        }

        // Inject MutationObserver into the page
        await page.evaluate((debounceMs) => {
            if (window.__autolanderObserver) {
                window.__autolanderObserver.disconnect();
            }

            const container = document.querySelector('[role="main"]') || document.body;
            let debounceTimer = null;

            const observer = new MutationObserver(() => {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    // Scan for unread thread indicators
                    const threads = [];
                    // Look for thread rows with bold/unread text
                    const rows = document.querySelectorAll('[role="row"], [role="listitem"], [data-testid]');
                    for (const row of rows) {
                        const spans = row.querySelectorAll('span');
                        let hasBold = false;
                        let previewText = '';
                        let buyerName = '';

                        for (const span of spans) {
                            const fw = parseInt(getComputedStyle(span).fontWeight);
                            const text = span.textContent?.trim() || '';
                            if (fw >= 600 && text.length > 0 && text.length < 100) {
                                hasBold = true;
                                if (!buyerName && text.length < 40) buyerName = text;
                                else if (!previewText) previewText = text;
                            }
                        }

                        if (hasBold && (buyerName || previewText)) {
                            threads.push({ buyerName, previewText, hasBold: true });
                        }
                    }

                    if (threads.length > 0) {
                        window.__autolanderNewMessage(JSON.stringify(threads));
                    }
                }, debounceMs);
            });

            observer.observe(container, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['class', 'style'],
            });

            window.__autolanderObserver = observer;
        }, DEBOUNCE_MS);

        console.log('[inbox-listener] MutationObserver injected');
    }

    async _disconnectObserver() {
        try {
            const monitor = await this.fbInboxAdapter._getMonitor();
            if (monitor?.page && !monitor.page.isClosed()) {
                await monitor.page.evaluate(() => {
                    window.__autolanderObserver?.disconnect();
                    window.__autolanderObserver = null;
                }).catch(() => {});
            }
        } catch {}
    }

    _onNewMessage(data) {
        if (this._paused || !this._active) return;

        let threads;
        try {
            threads = JSON.parse(data);
        } catch {
            return;
        }

        if (!Array.isArray(threads) || threads.length === 0) return;

        console.log(`[inbox-listener] Detected ${threads.length} unread thread(s)`);
        this._lastMessage = Date.now();

        // Queue them and process
        for (const t of threads) {
            // Simple dedup by buyer name
            if (!this._pendingThreads.some(p => p.buyerName === t.buyerName)) {
                this._pendingThreads.push(t);
            }
        }

        this._processQueue().catch(err => {
            console.error('[inbox-listener] Queue processing error:', err.message);
        });
    }

    async _processQueue() {
        if (this._processing || this._paused) return;
        this._processing = true;

        try {
            while (this._pendingThreads.length > 0 && this._active && !this._paused) {
                const threadInfo = this._pendingThreads.shift();
                await this._processThread(threadInfo);
            }
        } finally {
            this._processing = false;
        }
    }

    async _processThread(threadInfo) {
        const buyerName = threadInfo.buyerName || 'Unknown';
        console.log(`[inbox-listener] Processing thread for ${buyerName}`);

        try {
            const monitor = await this.fbInboxAdapter._getMonitor();

            // Navigate to this thread via the inbox - click on it or use Messenger URL
            // First do a full checkInbox-style read of just this one thread
            // The simplest approach: use the existing readThreadViaMessenger with the buyer name

            // Actually, the simplest reliable approach:
            // 1. We're on the inbox page
            // 2. Click the thread row matching this buyer name
            // 3. Read messages via GraphQL interception
            // 4. If buyer spoke last, get response and send

            // Use the adapter's existing flow to open and read the thread
            const result = await this.fbInboxAdapter.checkInbox();
            const threads = this._extractThreads(result);

            for (const thread of threads) {
                const messages = Array.isArray(thread?.messages) ? thread.messages : [];
                if (messages.length === 0) continue;

                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || !lastMsg.isBuyer) continue;

                const threadId = thread.threadId || thread.id;
                if (!threadId) continue;

                // Fingerprint check
                const lastBuyerText = (lastMsg.text || lastMsg.body || lastMsg.message || '').trim();
                const fingerprint = lastBuyerText.substring(0, 100);
                const prior = this._respondedTo.get(threadId);
                if (prior && prior.fingerprint === fingerprint) continue;

                // Get AI response
                const response = await this._getResponse(threadId, thread, messages);
                if (!response?.reply) continue;

                // Send to FB
                console.log(`[inbox-listener] ${thread.buyerName}: sending reply`);
                const sendResult = await this.fbInboxAdapter.sendMessage(
                    threadId,
                    response.reply,
                    thread.buyerName,
                    thread.listingTitle,
                    { skipNavigation: false, realThreadId: thread.realThreadId || thread._realFbId }
                );

                if (sendResult && sendResult.sent === false) {
                    console.error(`[inbox-listener] ${thread.buyerName}: send failed`);
                    continue;
                }

                console.log(`[inbox-listener] ${thread.buyerName}: reply sent`);
                this._messagesForwarded += 1;

                this._respondedTo.set(threadId, {
                    fingerprint,
                    respondedAt: Date.now(),
                });

                await this._saveSent(response.conversationId, response.reply);
            }

            // Navigate back to inbox for continued listening
            try {
                await monitor._goto(INBOX_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            } catch {
                await monitor._goto(MESSENGER_FALLBACK, { waitUntil: 'networkidle2', timeout: 30000 });
            }
            await new Promise(r => setTimeout(r, 1000));
            await this._injectObserver();

        } catch (err) {
            console.error(`[inbox-listener] Thread processing error for ${buyerName}:`, err.message);
        }

        // Purge stale fingerprints (>24h)
        const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;
        for (const [tid, entry] of this._respondedTo) {
            if (entry.respondedAt < staleThreshold) this._respondedTo.delete(tid);
        }
    }

    async _getResponse(threadId, thread, messages) {
        if (!this.serverUrl || !this.accessToken) return null;

        const endpoint = new URL(
            `/api/conversations/${encodeURIComponent(threadId)}/respond`,
            this.serverUrl
        ).toString();

        const lastBuyerMsg = [...messages].reverse().find(m => m.isBuyer);
        const body = {
            buyerName: thread.buyerName || '',
            listingTitle: thread.listingTitle || '',
            lastBuyerMessageText: (lastBuyerMsg?.text || '').substring(0, 200),
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
                console.error(`[inbox-listener] Respond failed: HTTP ${response.status}`);
                return null;
            }

            const result = await response.json();
            if (result.reply) {
                return { reply: result.reply, conversationId: result.conversationId };
            }
            if (result.reason) {
                console.log(`[inbox-listener] No reply: ${result.reason}`);
            }
            return null;
        } catch (err) {
            console.error('[inbox-listener] Respond error:', err.message);
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
        } catch (err) {
            console.error('[inbox-listener] Save sent failed:', err.message);
        }
    }

    async _watchdogCheck() {
        if (this._paused || !this._active || this._processing) return;

        try {
            const monitor = await this.fbInboxAdapter._getMonitor();
            const page = monitor.page;
            if (!page || page.isClosed()) {
                console.warn('[inbox-listener] Page closed, reinitializing');
                await this._startListening();
                return;
            }

            const url = page.url();
            const onInbox = url.includes('marketplace/inbox') || url.includes('messages/t');
            if (!onInbox) {
                console.log('[inbox-listener] Browser drifted from inbox, navigating back');
                try {
                    await monitor._goto(INBOX_URL, { waitUntil: 'networkidle2', timeout: 30000 });
                } catch {
                    await monitor._goto(MESSENGER_FALLBACK, { waitUntil: 'networkidle2', timeout: 30000 });
                }
                await new Promise(r => setTimeout(r, 1000));
                await this._injectObserver();
            }

            // Verify observer is still alive
            const observerAlive = await page.evaluate(() => {
                return typeof window.__autolanderNewMessage === 'function'
                    && window.__autolanderObserver !== null;
            }).catch(() => false);

            if (!observerAlive) {
                console.log('[inbox-listener] Observer lost, re-injecting');
                await this._injectObserver();
            }
        } catch (err) {
            console.warn('[inbox-listener] Watchdog error:', err.message);
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
}

module.exports = { InboxListener };
