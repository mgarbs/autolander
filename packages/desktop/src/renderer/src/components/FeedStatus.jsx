export default function FeedStatus({ feed }) {
  if (!feed) return null;

  const statusColor = feed.lastSyncStatus === 'success' ? 'text-green-400' :
                       feed.lastSyncStatus === 'error' ? 'text-red-400' :
                       'text-surface-400';

  return (
    <div className="glass-card p-3 flex items-center justify-between">
      <div>
        <p className="text-white text-sm font-medium">{feed.name || feed.feedUrl}</p>
        <p className="text-surface-500 text-xs">{feed.feedType} — {feed.vehicleCount} vehicles</p>
      </div>
      <div className="text-right">
        <p className={`text-xs ${statusColor}`}>
          {feed.lastSyncAt ? `Synced ${new Date(feed.lastSyncAt).toLocaleDateString()}` : 'Never synced'}
        </p>
        <p className="text-surface-500 text-xs">
          {feed.enabled ? 'Active' : 'Disabled'}
        </p>
      </div>
    </div>
  );
}
