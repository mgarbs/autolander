import { useInventory } from '../hooks/useInventory';
import Badge from '../components/Badge';
import { 
  CarFront, 
  Search, 
  Filter, 
  MapPin, 
  History, 
  ExternalLink,
  DollarSign,
  Zap,
  Tag,
  Share2
} from 'lucide-react';
import { motion } from 'framer-motion';

function formatPrice(price) {
  if (!price) return 'N/A';
  return '$' + price.toLocaleString();
}

export default function Inventory() {
  const { inventory, loading } = useInventory();
  const vehicles = (inventory?.vehicles || []).filter(v => v.listings?.facebook_marketplace?.posted);

  const live = vehicles.filter(v => v.status === 'available').length;
  const sold = vehicles.filter(v => v.status === 'sold' || v.status === 'potentially_sold').length;

  return (
    <div className="space-y-8 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <CarFront size={14} />
            Showroom Fleet
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
            Inventory <span className="text-brand-500">Assets</span>
          </h1>
          <p className="text-surface-500 font-medium">
            {vehicles.length} live on Marketplace &middot; {live} available &middot; {sold} sold
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="relative group">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-600 group-focus-within:text-brand-500 transition-colors" />
            <input 
              type="text" 
              placeholder="Search VIN or Model..."
              className="pl-9 pr-4 py-2.5 bg-surface-900 border border-surface-800 rounded-xl text-xs font-bold text-surface-400 focus:outline-none focus:border-brand-500/50 transition-all w-64"
            />
          </div>
          <button className="p-2.5 bg-surface-900 border border-surface-800 rounded-xl text-surface-400 hover:text-white transition-colors">
            <Filter size={18} />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-80 animate-pulse bg-surface-900/50" />
          ))
        ) : vehicles.length === 0 ? (
          <div className="col-span-full py-20 text-center opacity-50">
            <CarFront size={48} className="mx-auto mb-4 text-surface-700" />
            <p className="text-sm font-bold text-surface-400 uppercase tracking-widest">No inventory found</p>
            <p className="text-xs text-surface-600 mt-2">Try importing vehicles via CLI</p>
          </div>
        ) : (
          vehicles.map((v, idx) => (
            <motion.div
              key={v.vin}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              whileHover={{ y: -8 }}
              className="glass-card group overflow-hidden flex flex-col"
            >
              {/* Vehicle Photo */}
              <div className="h-40 bg-surface-950 relative overflow-hidden border-b border-surface-900/50">
                {v.photos?.[0] ? (
                  <img
                    src={v.photos[0]}
                    alt={`${v.year} ${v.make} ${v.model}`}
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <CarFront size={64} className="text-surface-900 transform -rotate-12 group-hover:scale-110 transition-transform duration-500" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-surface-950 to-transparent opacity-60 z-10 pointer-events-none" />

                <div className="absolute top-4 left-4 z-20 flex flex-col gap-2">
                   <Badge variant={v.status === 'available' ? 'success' : v.status === 'sold' ? 'brand' : 'warning'} size="xs">
                     {v.status || 'available'}
                   </Badge>
                   {v.listings?.facebook_marketplace?.posted && (
                     <Badge variant="brand" size="xs">
                        <Share2 size={8} className="mr-1" />
                        LIVE ON FB
                     </Badge>
                   )}
                </div>

                <div className="absolute bottom-4 right-4 z-20">
                   <div className="px-3 py-1.5 bg-brand-500 text-white font-black text-sm rounded-lg shadow-glow-blue italic">
                     {formatPrice(v.price)}
                   </div>
                </div>
              </div>

              <div className="p-5 flex-1 flex flex-col">
                <div className="mb-4">
                  <h3 className="text-lg font-black text-white leading-tight group-hover:text-brand-400 transition-colors">
                    {v.year} {v.make} {v.model}
                  </h3>
                  <p className="text-[10px] font-bold text-surface-500 uppercase tracking-widest flex items-center gap-2 mt-1">
                    <Tag size={10} />
                    {v.trim || 'Standard Trim'} &middot; {v.body_style || 'N/A'}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold text-surface-600 uppercase tracking-widest">Odometer</span>
                    <span className="text-sm font-semibold text-surface-300">
                      {v.mileage ? v.mileage.toLocaleString() : 'N/A'} <span className="text-[10px] text-surface-600 ml-0.5">MI</span>
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-bold text-surface-600 uppercase tracking-widest">Exterior</span>
                    <span className="text-sm font-semibold text-surface-300 truncate">{v.exterior_color || 'N/A'}</span>
                  </div>
                </div>

                <div className="mt-auto pt-4 border-t border-surface-900/50 flex items-center justify-between">
                   <div className="flex items-center gap-1.5 text-[10px] font-bold text-surface-500 uppercase tracking-widest">
                     <History size={12} className="text-brand-500/50" />
                     {v.vin?.slice(-8) || 'NO VIN'}
                   </div>
                   <button className="p-2 bg-surface-900 hover:bg-surface-800 rounded-lg text-surface-400 hover:text-brand-400 transition-all">
                     <ExternalLink size={16} />
                   </button>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
