import { useState, useEffect, useRef } from 'react';
import { useInventory } from '../hooks/useInventory';
import { useRealtime } from '../context/RealtimeContext';
import { markVehicleSold } from '../api/client';
import { buildFeedAutoSyncMessage, getFeedAutoSyncDismissMs } from '../lib/feed-auto-sync';
import Badge from '../components/Badge';
import FilterDropdown from '../components/FilterDropdown';
import { 
  CarFront, 
  Search, 
  MapPin, 
  History, 
  ExternalLink,
  DollarSign,
  Zap,
  Tag,
  Share2,
  RefreshCw,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

function formatPrice(price) {
  if (!price) return 'N/A';
  return '$' + price.toLocaleString();
}

export default function Inventory() {
  const { inventory, loading, refresh } = useInventory();
  const { lastEvents } = useRealtime();
  const [showRefreshBanner, setShowRefreshBanner] = useState(false);
  const [autoSyncMsg, setAutoSyncMsg] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMake, setFilterMake] = useState('All');
  const [filterBody, setFilterBody] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [sortBy, setSortBy] = useState('price-asc');
  const autoSyncDismissRef = useRef(null);

  useEffect(() => {
    if (lastEvents.inventory) {
      setShowRefreshBanner(true);
    }
  }, [lastEvents.inventory]);

  useEffect(() => {
    if (!window.autolander?.onFeedAutoSync) return undefined;

    const clearDismissTimer = () => {
      if (autoSyncDismissRef.current) {
        clearTimeout(autoSyncDismissRef.current);
        autoSyncDismissRef.current = null;
      }
    };

    const stopListening = window.autolander.onFeedAutoSync((event) => {
      const message = buildFeedAutoSyncMessage(event);
      if (!message) return;

      clearDismissTimer();
      setAutoSyncMsg(message);

      if (event.type === 'auto-sync-complete') {
        setShowRefreshBanner(true);
      }

      const dismissMs = getFeedAutoSyncDismissMs(event);
      if (dismissMs > 0) {
        autoSyncDismissRef.current = setTimeout(() => {
          setAutoSyncMsg(null);
          autoSyncDismissRef.current = null;
        }, dismissMs);
      }
    });

    return () => {
      clearDismissTimer();
      stopListening();
    };
  }, []);

  const handleRefresh = () => {
    setShowRefreshBanner(false);
    refresh();
  };

  const handleMarkSold = async (vehicle) => {
    const confirmed = window.confirm(
      `Mark ${vehicle.year} ${vehicle.make} ${vehicle.model} as sold? This will also remove it from Facebook Marketplace.`
    );
    if (!confirmed) return;

    try {
      await markVehicleSold(vehicle.id);
      const listingUrl = vehicle.listings?.facebook_marketplace?.listingUrl;
      if (listingUrl && window.autolander?.fb?.delistVehicle) {
        window.autolander.fb.delistVehicle({ listingUrl }).catch(() => {});
      }
      refresh();
    } catch (e) {
      alert(e.message || 'Failed to mark as sold');
    }
  };

  const allVehicles = inventory?.vehicles || [];
  const makes = [...new Set(allVehicles.map(v => v.make).filter(Boolean))].sort();
  const bodyStyles = [...new Set(allVehicles.map(v => (v.body_style || v.bodyStyle || '').trim()).filter(Boolean))].sort();

  const q = searchQuery.toLowerCase().trim();
  let vehicles = allVehicles.filter(v => {
    if (q) {
      const haystack = `${v.year} ${v.make} ${v.model} ${v.trim || ''} ${v.vin || ''} ${v.exterior_color || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterMake !== 'All' && v.make !== filterMake) return false;
    if (filterBody !== 'All' && (v.body_style || v.bodyStyle || '') !== filterBody) return false;
    
    if (filterStatus === 'needs_update') {
      if (!v.listings?.facebook_marketplace?.stale) return false;
    } else if (filterStatus !== 'All' && (v.status || 'available') !== filterStatus) {
      return false;
    }
    
    return true;
  });

  vehicles.sort((a, b) => {
    switch (sortBy) {
      case 'price-asc': return (Number(a.price) || 0) - (Number(b.price) || 0);
      case 'price-desc': return (Number(b.price) || 0) - (Number(a.price) || 0);
      case 'year-desc': return (Number(b.year) || 0) - (Number(a.year) || 0);
      case 'year-asc': return (Number(a.year) || 0) - (Number(b.year) || 0);
      default: return 0;
    }
  });

  const live = allVehicles.filter(v => (v.status || 'available') === 'available').length;
  const sold = allVehicles.filter(v => v.status === 'sold' || v.status === 'potentially_sold').length;

  return (
    <div className="space-y-8 pb-12">
      {autoSyncMsg && (
        <div className={`flex items-center gap-2 p-3 rounded-2xl text-xs font-bold uppercase tracking-widest ${
          autoSyncMsg.type === 'success'
            ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
            : autoSyncMsg.type === 'info'
            ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
            : 'bg-rose-500/10 border border-rose-500/20 text-rose-400'
        }`}>
          {autoSyncMsg.type === 'success' ? <Zap size={14} /> : autoSyncMsg.type === 'info' ? <RefreshCw size={14} className="animate-spin" /> : <AlertCircle size={14} />}
          {autoSyncMsg.text}
        </div>
      )}

      <AnimatePresence>
        {showRefreshBanner && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <button 
              onClick={handleRefresh}
              className="w-full bg-brand-500/10 border border-brand-500/20 py-3 rounded-2xl flex items-center justify-center gap-3 group hover:bg-brand-500/20 transition-all"
            >
              <RefreshCw size={16} className="text-brand-500 group-hover:rotate-180 transition-transform duration-500" />
              <span className="text-sm font-black uppercase tracking-widest text-brand-400">
                New inventory updates available — click to refresh
              </span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

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
            {allVehicles.length} total vehicles &middot; {live} available &middot; {sold} sold
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="relative group">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-600 group-focus-within:text-brand-500 transition-colors" />
            <input
              type="text"
              placeholder="Search VIN or Model..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-4 py-2.5 bg-surface-900 border border-surface-800 rounded-xl text-xs font-bold text-surface-400 focus:outline-none focus:border-brand-500/50 transition-all w-64"
            />
          </div>
        </div>
      </header>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="w-48">
          <FilterDropdown
            label="Make"
            value={filterMake}
            onChange={setFilterMake}
            options={[{ value: 'All', label: 'All Makes' }, ...makes.map(m => ({ value: m, label: m }))]}
          />
        </div>
        <div className="w-48">
          <FilterDropdown
            label="Body Type"
            value={filterBody}
            onChange={setFilterBody}
            options={[{ value: 'All', label: 'All Body Styles' }, ...bodyStyles.map(b => ({ value: b, label: b }))]}
          />
        </div>
        <div className="w-48">
          <FilterDropdown
            label="Status"
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { value: 'All', label: 'All Status' },
              { value: 'available', label: 'Available' },
              { value: 'needs_update', label: 'Needs Update' },
              { value: 'sold', label: 'Sold' },
              { value: 'potentially_sold', label: 'Potentially Sold' },
            ]}
          />
        </div>
        <div className="w-48 ml-auto">
          <FilterDropdown
            label="Sort By"
            value={sortBy}
            onChange={setSortBy}
            options={[
              { value: 'price-asc', label: 'Price: Low → High' },
              { value: 'price-desc', label: 'Price: High → Low' },
              { value: 'year-desc', label: 'Year: Newest' },
              { value: 'year-asc', label: 'Year: Oldest' },
            ]}
          />
        </div>
      </div>

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
                   {v.listings?.facebook_marketplace?.stale && (
                      <Badge variant="warning" size="xs">
                        <AlertCircle size={8} className="mr-1" />
                        {(() => {
                          const reason = v.listings.facebook_marketplace.staleReason || '';
                          const priceMatch = reason.match(/price_changed:([\d.]+)->([\d.]+)/);
                          if (priceMatch) {
                            return `$${Number(priceMatch[1]).toLocaleString()} → $${Number(priceMatch[2]).toLocaleString()}`;
                          }
                          return 'NEEDS UPDATE';
                        })()}
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
                   <div className="flex items-center gap-2">
                     {v.listings?.facebook_marketplace?.posted && v.status === 'available' && (
                       <button
                         onClick={() => handleMarkSold(v)}
                         className="px-2 py-1 text-[10px] font-black uppercase tracking-widest text-surface-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
                       >
                         Mark Sold
                       </button>
                     )}
                     <button className="p-2 bg-surface-900 hover:bg-surface-800 rounded-lg text-surface-400 hover:text-brand-400 transition-all">
                       <ExternalLink size={16} />
                     </button>
                   </div>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
