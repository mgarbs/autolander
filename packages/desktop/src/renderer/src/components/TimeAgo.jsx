export default function TimeAgo({ date }) {
  if (!date) return <span className="text-slate-500">--</span>;

  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  let text;
  if (seconds < 60) text = 'just now';
  else if (seconds < 3600) text = `${Math.floor(seconds / 60)}m ago`;
  else if (seconds < 86400) text = `${Math.floor(seconds / 3600)}h ago`;
  else text = `${Math.floor(seconds / 86400)}d ago`;

  return <span className="text-slate-400 text-sm">{text}</span>;
}
