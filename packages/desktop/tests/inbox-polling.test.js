'use strict';

const { InboxPolling } = require('../src/worker/inbox-polling');

describe('InboxPolling._poll()', () => {
  test('calls checkInbox and syncs threads to cloud via fetch', async () => {
    const fakeThread = {
      threadId: 'thread-1',
      buyerName: 'Alice',
      listingTitle: '2020 Civic',
      messages: [{ text: 'Is this available?', isBuyer: true }],
    };

    const mockAdapter = {
      checkInbox: jest.fn().mockResolvedValue([fakeThread]),
    };

    const poller = new InboxPolling({ fbInboxAdapter: mockAdapter });
    poller.serverUrl = 'http://localhost:3000';
    poller.accessToken = 'test-token';

    // Mock global fetch
    const mockResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({ newInbound: 1 }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    await poller._poll();

    expect(mockAdapter.checkInbox).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/conversations/thread-1/sync');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-token');

    const body = JSON.parse(opts.body);
    expect(body.buyerName).toBe('Alice');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].text).toBe('Is this available?');
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
