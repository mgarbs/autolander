export default function Badge({ children, variant = 'default', size = 'sm' }) {
  const base = "inline-flex items-center justify-center font-bold tracking-widest uppercase rounded-full border transition-all duration-300";
  
  const sizes = {
    xs: "px-1.5 py-0.5 text-[8px]",
    sm: "px-2 py-0.5 text-[10px]",
    md: "px-3 py-1 text-xs"
  };

  const variants = {
    default: "bg-surface-800/50 text-surface-400 border-surface-700/50",
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 shadow-glow-green",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-glow-amber",
    error: "bg-rose-500/10 text-rose-400 border-rose-500/20 shadow-glow-red",
    brand: "bg-brand-500/10 text-brand-400 border-brand-500/20 shadow-glow-blue",
    hot: "bg-gradient-to-r from-rose-600/20 to-orange-600/20 text-rose-400 border-rose-500/30 animate-pulse shadow-glow-red"
  };

  return (
    <span className={`${base} ${sizes[size]} ${variants[variant]}`}>
      {children}
    </span>
  );
}
