import { motion } from 'framer-motion';

export default function ScoreBreakdown({ breakdown, score }) {
  const total = score || 0;

  const getLabel = () => {
    if (total >= 70) return { text: 'High Intent', color: 'text-rose-500' };
    if (total >= 45) return { text: 'Engaged', color: 'text-orange-500' };
    if (total >= 20) return { text: 'Early Stage', color: 'text-indigo-500' };
    return { text: 'New Lead', color: 'text-surface-500' };
  };

  const getBarColor = () => {
    if (total >= 70) return 'bg-rose-500';
    if (total >= 45) return 'bg-orange-500';
    if (total >= 20) return 'bg-indigo-500';
    return 'bg-surface-600';
  };

  const label = getLabel();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className={`text-sm font-black uppercase tracking-widest ${label.color}`}>
          {label.text}
        </span>
        <span className="text-2xl font-black text-white italic">{total}<span className="text-sm text-surface-500 ml-1">/100</span></span>
      </div>
      <div className="relative h-3 w-full bg-surface-950 rounded-full overflow-hidden border border-surface-900/50 p-0.5">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${total}%` }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
          className={`${getBarColor()} h-full rounded-full`}
        />
      </div>
    </div>
  );
}
