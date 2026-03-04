import { motion } from 'framer-motion';

export default function ScoreBreakdown({ breakdown, score }) {
  if (!breakdown) return null;

  const { stateScore, intentScore, signalModifier, base } = breakdown;
  const total = score || 100;
  const maxBar = 100;

  const segments = [
    { label: 'State', value: Math.round(stateScore * 0.5), color: 'bg-brand-500', glow: 'shadow-glow-blue' },
    { label: 'Intent', value: Math.round(intentScore * 0.3), color: 'bg-emerald-500', glow: 'shadow-emerald-500/20' },
    { label: 'Signals', value: Math.round(signalModifier * 0.2), color: signalModifier >= 0 ? 'bg-amber-500' : 'bg-rose-500', glow: '' },
    { label: 'Base AI', value: base, color: 'bg-surface-600', glow: '' },
  ];

  return (
    <div className="space-y-6">
      <div className="relative h-3 w-full bg-surface-950 rounded-full overflow-hidden border border-surface-900/50 p-0.5">
        <div className="flex h-full w-full rounded-full overflow-hidden">
          {segments.map(seg => (
            seg.value > 0 && (
              <motion.div
                key={seg.label}
                initial={{ width: 0 }}
                animate={{ width: `${(seg.value / maxBar) * 100}%` }}
                transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                className={`${seg.color} h-full border-r border-surface-950/20 last:border-r-0`}
                title={`${seg.label}: ${seg.value}`}
              />
            )
          ))}
        </div>
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {segments.map(seg => (
          <div key={seg.label} className="bg-surface-950/50 p-3 rounded-xl border border-surface-900/50 flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
               <div className={`w-1.5 h-1.5 rounded-full ${seg.color} ${seg.glow}`} />
               <span className="text-[10px] font-black uppercase tracking-widest text-surface-600">
                 {seg.label}
               </span>
            </div>
            <div className="text-sm font-black text-surface-200">
               {seg.value}
               <span className="text-[10px] text-surface-700 ml-1">pts</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
