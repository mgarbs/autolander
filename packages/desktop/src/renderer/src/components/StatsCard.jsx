import { motion } from 'framer-motion';

export default function StatsCard({ 
  label, 
  value, 
  subtext, 
  highlight, 
  icon: Icon, 
  trend,
  trendValue
}) {
  return (
    <motion.div
      whileHover={{ y: -4, scale: 1.01 }}
      className={`relative group overflow-hidden ${
        highlight 
          ? 'bg-gradient-to-br from-brand-600 to-brand-900 border-brand-500/20' 
          : 'glass-card'
      } p-6 border transition-all duration-300`}
    >
      {/* Glow Effect */}
      <div className={`absolute -right-10 -top-10 w-32 h-32 blur-3xl rounded-full opacity-20 transition-opacity duration-500 group-hover:opacity-40 ${
        highlight ? 'bg-brand-400' : 'bg-brand-500'
      }`} />
      
      <div className="relative z-10">
        <div className="flex items-start justify-between mb-4">
          <div className={`text-sm font-medium tracking-tight uppercase ${
            highlight ? 'text-brand-100/70' : 'text-surface-400'
          }`}>
            {label}
          </div>
          {Icon && (
            <div className={`p-2 rounded-lg ${
              highlight ? 'bg-white/10 text-white' : 'bg-surface-800 text-brand-500 shadow-glow-blue'
            }`}>
              <Icon size={18} />
            </div>
          )}
        </div>
        
        <div className="flex items-baseline gap-2">
          <div className={`text-4xl font-bold tracking-tight ${
            highlight ? 'text-white' : 'text-surface-100'
          }`}>
            {value}
          </div>
          {trend && (
            <div className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              trend === 'up' 
                ? 'bg-emerald-500/10 text-emerald-400' 
                : 'bg-red-500/10 text-red-400'
            }`}>
              {trend === 'up' ? '↑' : '↓'} {trendValue}%
            </div>
          )}
        </div>
        
        {subtext && (
          <div className={`mt-2 text-xs font-medium ${
            highlight ? 'text-brand-200/60' : 'text-surface-500'
          }`}>
            {subtext}
          </div>
        )}
      </div>
    </motion.div>
  );
}
