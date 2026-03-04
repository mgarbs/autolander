import { motion } from 'framer-motion';

const tabs = [
  { key: null, label: 'All' },
  { key: 'hot', label: 'Hot' },
  { key: 'warm', label: 'Warm' },
  { key: 'cold', label: 'Cold' },
  { key: 'dead', label: 'Dead' },
];

export default function FilterTabs({ active, onChange }) {
  return (
    <div className="flex gap-1.5 bg-surface-950/50 rounded-xl p-1.5 border border-surface-900/50 backdrop-blur-sm">
      {tabs.map(tab => (
        <button
          key={tab.key || 'all'}
          onClick={() => onChange(tab.key)}
          className={`relative px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${
            active === tab.key
              ? 'text-white'
              : 'text-surface-500 hover:text-surface-300'
          }`}
        >
          {active === tab.key && (
            <motion.div
              layoutId="active-tab"
              className="absolute inset-0 bg-brand-500 rounded-lg shadow-glow-blue"
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
            />
          )}
          <span className="relative z-10">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
