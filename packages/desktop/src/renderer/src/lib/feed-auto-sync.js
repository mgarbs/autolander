export function buildFeedAutoSyncMessage(event) {
  if (!event?.type) return null;

  switch (event.type) {
    case 'auto-sync-start':
      return {
        type: 'info',
        text: event.feedCount > 0
          ? `Starting inventory sync for ${event.feedCount} ${event.feedCount === 1 ? 'feed' : 'feeds'}...`
          : 'No browser-protected inventory feeds are enabled.',
      };
    case 'auto-sync-feed-start':
      return {
        type: 'info',
        text: `Syncing ${event.feedName} (${event.feedIndex} of ${event.feedCount})...`,
      };
    case 'auto-sync-page':
      return {
        type: 'info',
        text: `${event.feedName}: loading page ${event.page} of ${event.totalPages}...`,
      };
    case 'auto-sync-feed-done':
      return {
        type: 'success',
        text: `${event.feedName}: ${event.vehiclesFound} vehicles synced (${event.vehiclesAdded} new, ${event.vehiclesUpdated} updated)`,
      };
    case 'auto-sync-feed-error':
      return {
        type: 'error',
        text: `${event.feedName}: sync failed - ${event.error}`,
      };
    case 'auto-sync-complete':
      return {
        type: 'success',
        text: event.feedCount > 0
          ? `All feeds synced: ${event.totalVehicles} vehicles across ${event.feedCount} ${event.feedCount === 1 ? 'feed' : 'feeds'} (${event.totalAdded} new, ${event.totalUpdated} updated)`
          : 'Background sync checked for browser-protected feeds and found none enabled.',
      };
    case 'auto-sync-error':
      return {
        type: 'error',
        text: `Background sync failed: ${event.error}`,
      };
    default:
      return null;
  }
}

export function getFeedAutoSyncDismissMs(event) {
  if (!event?.type) return 0;
  if (event.type === 'auto-sync-complete' || event.type === 'auto-sync-error') {
    return 10000;
  }
  return 0;
}
