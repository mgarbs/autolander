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

export function buildImageFetchMessage(event) {
  if (!event?.type) return null;

  switch (event.type) {
    case 'image-fetch-start':
      return {
        type: 'info',
        text: event.total > 0
          ? `${event.feedName}: fetching photos for ${event.total} vehicles...`
          : `${event.feedName}: no vehicles need photos.`,
      };
    case 'image-fetch-progress':
      return {
        type: 'info',
        text: `${event.feedName}: photos ${event.current} of ${event.total} - ${event.vehicleName}`,
      };
    case 'image-fetch-complete':
      return {
        type: 'success',
        text: `${event.feedName}: photo fetch complete (${event.updated} updated${event.skipped ? `, ${event.skipped} skipped` : ''})`,
      };
    case 'image-fetch-error':
      return {
        type: 'error',
        text: `${event.feedName}: photo fetch failed - ${event.error}`,
      };
    case 'image-fetch-cancelled':
      return {
        type: 'info',
        text: `${event.feedName}: photo fetch cancelled`,
      };
    default:
      return null;
  }
}

export function getSyncDismissMs(event) {
  const autoSyncDismissMs = getFeedAutoSyncDismissMs(event);
  if (autoSyncDismissMs > 0) return autoSyncDismissMs;

  if (!event?.type) return 0;
  if (
    event.type === 'image-fetch-complete' ||
    event.type === 'image-fetch-error' ||
    event.type === 'image-fetch-cancelled'
  ) {
    return 10000;
  }

  return 0;
}
