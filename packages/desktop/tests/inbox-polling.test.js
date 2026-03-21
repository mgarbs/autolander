'use strict';

const { InboxPolling } = require('../src/worker/inbox-polling');

describe('InboxPolling._poll()', () => {
  test('calls checkInbox and requests response from cloud via /respond', async () => {
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

    // Mock global fetch — /respond returns a reply, /confirm-sent returns ok
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/respond')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ reply: 'Yes it is!', messageId: 'msg-1' }),
        });
      }
      // confirm-sent
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });

    await poller._poll();

    expect(mockAdapter.checkInbox).toHaveBeenCalledTimes(1);

    // First fetch call should be to /respond
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/conversations/thread-1/respond');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-token');

    const body = JSON.parse(opts.body);
    expect(body.buyerName).toBe('Alice');
    expect(body.lastBuyerMessageText).toBe('Is this available?');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('Is this available?');

    // Should have sent the reply to FB
    expect(mockAdapter.sendMessage).toHaveBeenCalledTimes(1);

    // Second fetch should be confirm-sent
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toContain('/confirm-sent');
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
          json: () => Promise.resolve({ reply: 'Yes!', messageId: 'msg-1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
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
          json: () => Promise.resolve({ reply: 'Response!', messageId: 'msg-1' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
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
