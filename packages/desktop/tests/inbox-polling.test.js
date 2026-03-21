'use strict';

const { InboxPolling } = require('../src/worker/inbox-polling');

describe('InboxPolling._poll()', () => {
  test('sends reply to FB then saves to DB (not before)', async () => {
    const fakeThread = {
      threadId: 'thread-1',
      buyerName: 'Alice',
      listingTitle: '2020 Civic',
      messages: [{ text: 'Is this available?', isBuyer: true, timestamp: '1711000000000' }],
    };

    const mockAdapter = {
      checkInbox: jest.fn().mockResolvedValue([fakeThread]),
      sendMessage: jest.fn().mockResolvedValue(true),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });
    poller.serverUrl = 'http://localhost:3000';
    poller.accessToken = 'test-token';

    const fetchCalls = [];
    global.fetch = jest.fn().mockImplementation((url, opts) => {
      fetchCalls.push({ url, method: opts?.method });
      if (url.includes('/respond')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reply: 'Yes it is!', conversationId: 'conv-1' }),
        });
      }
      // save-sent via POST /messages
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'msg-1' }) });
    });

    await poller._poll();

    expect(mockAdapter.checkInbox).toHaveBeenCalledTimes(1);

    // First fetch: /respond
    expect(fetchCalls[0].url).toContain('/api/conversations/thread-1/respond');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.buyerName).toBe('Alice');
    expect(body.lastBuyerMessageText).toBe('Is this available?');
    expect(body.messages[0].timestamp).toBe('1711000000000');

    // FB send happened
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);

    // Second fetch: save-sent via POST /messages (AFTER FB send)
    expect(fetchCalls[1].url).toContain('/messages');
    expect(fetchCalls[1].method).toBe('POST');
    const saveBody = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(saveBody.direction).toBe('OUTBOUND');
    expect(saveBody.text).toBe('Yes it is!');
    expect(saveBody.intent).toBe('auto_reply');
    expect(saveBody.status).toBe('SENT');
  });

  test('does NOT save to DB when FB send fails', async () => {
    const fakeThread = {
      threadId: 'thread-1',
      buyerName: 'Alice',
      messages: [{ text: 'Is this available?', isBuyer: true }],
    };

    const mockAdapter = {
      checkInbox: jest.fn().mockResolvedValue([fakeThread]),
      sendMessage: jest.fn().mockRejectedValue(new Error('Chrome crashed')),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });
    poller.serverUrl = 'http://localhost:3000';
    poller.accessToken = 'test-token';

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/respond')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reply: 'Yes!', conversationId: 'conv-1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await poller._poll();

    // /respond was called
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/respond');

    // FB send was attempted but failed
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);

    // No save-sent call — message not saved to DB
    expect(global.fetch).toHaveBeenCalledTimes(1); // only /respond, no /messages
  });

  test('skips thread if already responded to same conversation state', async () => {
    const fakeThread = {
      threadId: 'thread-1',
      buyerName: 'Alice',
      listingTitle: '2020 Civic',
      messages: [{ text: 'Is this available?', isBuyer: true }],
    };

    const mockAdapter = {
      checkInbox: jest.fn().mockResolvedValue([fakeThread]),
      sendMessage: jest.fn().mockResolvedValue(true),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });
    poller.serverUrl = 'http://localhost:3000';
    poller.accessToken = 'test-token';

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/respond')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reply: 'Yes!', conversationId: 'conv-1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // First poll — should respond
    await poller._poll();
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);

    // Reset mocks for second poll
    mockAdapter.sendMessage.mockClear();
    global.fetch.mockClear();
    poller._running = false;

    // Second poll with same thread state — should skip (already responded)
    await poller._poll();
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(0);
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });

  test('responds again when buyer sends a new message', async () => {
    const mockAdapter = {
      checkInbox: jest.fn(),
      sendMessage: jest.fn().mockResolvedValue(true),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });
    poller.serverUrl = 'http://localhost:3000';
    poller.accessToken = 'test-token';

    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/respond')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reply: 'Response!', conversationId: 'conv-1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // First poll with one message
    mockAdapter.checkInbox.mockResolvedValueOnce([{
      threadId: 'thread-1',
      buyerName: 'Alice',
      messages: [{ text: 'Is this available?', isBuyer: true }],
    }]);
    await poller._poll();
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);

    // Reset
    mockAdapter.sendMessage.mockClear();
    global.fetch.mockClear();
    poller._running = false;

    // Second poll — buyer sent a new message (different last buyer text)
    mockAdapter.checkInbox.mockResolvedValueOnce([{
      threadId: 'thread-1',
      buyerName: 'Alice',
      messages: [
        { text: 'Is this available?', isBuyer: true },
        { text: 'Yes!', isBuyer: false },
        { text: 'Can I come today?', isBuyer: true },
      ],
    }]);
    await poller._poll();
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('handles checkInbox failure without crashing', async () => {
    const mockAdapter = {
      checkInbox: jest.fn().mockRejectedValue(new Error('Network timeout')),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });

    const errors = [];
    poller.on('poll-error', (evt) => errors.push(evt));

    // Should not throw
    await poller._poll();

    expect(mockAdapter.checkInbox).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('Network timeout');
  });
});
