'use strict';

// TODO: Phase 4 — fetch feed URL → parse → validate → Prisma upsert with price history

module.exports = {
  async syncFeed(feed, prisma) {
    console.log(`[feed-sync] Sync not yet implemented for feed ${feed.id}`);
    return { vehiclesFound: 0, vehiclesAdded: 0, vehiclesUpdated: 0 };
  },
};
