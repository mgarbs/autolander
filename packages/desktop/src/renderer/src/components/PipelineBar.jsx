import { motion } from 'framer-motion';

const stages = [
  { key: 'hot', label: 'Hot', color: 'bg-rose-500', glow: 'shadow-glow-red' },
  { key: 'warm', label: 'Warm', color: 'bg-orange-500', glow: 'shadow-orange-500/20' },
  { key: 'cold', label: 'Cold', color: 'bg-indigo-500', glow: 'shadow-indigo-500/20' },
  { key: 'dead', label: 'Dead', color: 'bg-surface-700', glow: '' }
];

export default function PipelineBar({ pipeline }) {
  const total = Object.values(pipeline).reduce((acc, val) => acc + (val || 0), 0);
  
  return (
    <div className="space-y-6">
      <div className="flex h-4 w-full bg-surface-900 rounded-full overflow-hidden border border-surface-800 p-0.5">
        {stages.map((stage) => {
          const value = pipeline[stage.key] || 0;
          const percentage = total === 0 ? 0 : (value / total) * 100;
          
          if (percentage === 0) return null;
          
          return (
            <motion.div
              key={stage.key}
              initial={{ width: 0 }}
              animate={{ width: `${percentage}%` }}
              transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
              className={`h-full ${stage.color} rounded-full first:rounded-l-full last:rounded-r-full border-r border-surface-950/20 last:border-r-0 shadow-sm transition-all relative group`}
            >
              {/* Tooltip or hover effect if needed */}
              <div className="absolute -top-1 inset-x-0 h-1 opacity-50 bg-white/20 blur-[1px] rounded-full mx-1" />
            </motion.div>
          );
        })}
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stages.map((stage) => (
          <div key={stage.key} className="flex flex-col gap-1 p-3 rounded-xl border border-surface-800/50 bg-surface-900/30">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${stage.color} ${stage.glow}`} />
              <span className="text-[10px] font-bold uppercase tracking-widest text-surface-500">
                {stage.label}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold text-surface-200">
                {pipeline[stage.key] || 0}
              </span>
              <span className="text-[10px] text-surface-600 font-medium">
                {total === 0 ? '0%' : Math.round(((pipeline[stage.key] || 0) / total) * 100)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
