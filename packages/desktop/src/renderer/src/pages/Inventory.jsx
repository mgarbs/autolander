import { useState } from 'react';
import { useInventory } from '../hooks/useInventory';
import { markVehicleSold, getFeeds, syncFeed, syncFeedHtml } from '../api/client';
import Badge from '../components/Badge';
import FilterDropdown from '../components/FilterDropdown';
import {
  CarFront,
  Search,
  History,
  ExternalLink,
  Tag,
  Share2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RefreshCw
} from 'lucide-react';
import { motion } from 'framer-motion';

const PER_PAGE = 12;

function formatPrice(price) {
  if (!price) return 'N/A';
  return '$' + price.toLocaleString();
}

export default function Inventory() {
  const { inventory, loading, refresh } = useInventory();
  const [searchQuery, setSearchQuery] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [filterMake, setFilterMake] = useState('All');
  const [filterBody, setFilterBody] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [sortBy, setSortBy] = useState('price-asc');
  const [page, setPage] = useState(1);

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
    } else if (filterStatus === 'posted') {
      if (!v.listings?.facebook_marketplace?.posted) return false;
    } else if (filterStatus === 'not_posted') {
      if (v.listings?.facebook_marketplace?.posted) return false;
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

  // Pagination
  const totalFiltered = vehicles.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginated = vehicles.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const pageNumbers = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= safePage - 1 && i <= safePage + 1)) {
      pageNumbers.push(i);
    } else if (pageNumbers[pageNumbers.length - 1] !== '...') {
      pageNumbers.push('...');
    }
  }

  const live = allVehicles.filter(v => (v.status || 'available') === 'available').length;
  const posted = allVehicles.filter(v => v.listings?.facebook_marketplace?.posted).length;
  const sold = allVehicles.filter(v => v.status === 'sold' || v.status === 'potentially_sold').length;

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
            {allVehicles.length} total &middot; {live} available &middot; {posted} posted to FB &middot; {sold} sold
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (syncing) return;
              setSyncing(true);
              try {
                const feedsData = await getFeeds();
                const feeds = feedsData.feeds || feedsData || [];
                const feed = feeds[0];
                if (!feed) { alert('No feed configured'); return; }
                if (window.autolander?.fetchFeedHtml) {
                  const fetchResult = await window.autolander.fetchFeedHtml(feed.feedUrl);
                  if (fetchResult.success && fetchResult.html) {
                    await syncFeedHtml(feed.id, fetchResult.html);
                  }
                } else {
                  await syncFeed(feed.id);
                }
                refresh();
              } catch (e) {
                console.error('Sync failed:', e.message);
              } finally {
                setSyncing(false);
              }
            }}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2.5 bg-surface-900 border border-surface-800 rounded-xl text-xs font-bold text-surface-400 hover:text-white hover:border-brand-500/50 transition-all active:scale-95 disabled:opacity-60"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync Inventory'}
          </button>
          <div className="relative group">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-600 group-focus-within:text-brand-500 transition-colors" />
            <input
              type="text"
              placeholder="Search VIN or Model..."
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
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
            onChange={(v) => { setFilterMake(v); setPage(1); }}
            options={[{ value: 'All', label: 'All Makes' }, ...makes.map(m => ({ value: m, label: m }))]}
          />
        </div>
        <div className="w-48">
          <FilterDropdown
            label="Body Type"
            value={filterBody}
            onChange={(v) => { setFilterBody(v); setPage(1); }}
            options={[{ value: 'All', label: 'All Body Styles' }, ...bodyStyles.map(b => ({ value: b, label: b }))]}
          />
        </div>
        <div className="w-48">
          <FilterDropdown
            label="Status"
            value={filterStatus}
            onChange={(v) => { setFilterStatus(v); setPage(1); }}
            options={[
              { value: 'All', label: 'All Status' },
              { value: 'available', label: 'Available' },
              { value: 'posted', label: 'Posted to FB' },
              { value: 'not_posted', label: 'Not Posted to FB' },
              { value: 'needs_update', label: 'Needs Update' },
              { value: 'sold', label: 'Sold' },
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

      {!loading && totalFiltered > 0 && (
        <p className="text-[10px] font-bold text-surface-500 uppercase tracking-widest">
          Showing {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, totalFiltered)} of {totalFiltered} vehicles
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-80 animate-pulse bg-surface-900/50" />
          ))
        ) : paginated.length === 0 ? (
          <div className="col-span-full py-20 text-center opacity-50">
            <CarFront size={48} className="mx-auto mb-4 text-surface-700" />
            <p className="text-sm font-bold text-surface-400 uppercase tracking-widest">No inventory found</p>
            <p className="text-xs text-surface-600 mt-2">Try importing vehicles via CLI</p>
          </div>
        ) : (
          paginated.map((v, idx) => (
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
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-surface-900/50">
                    <CarFront size={40} className="text-surface-700" />
                    <span className="text-[9px] font-bold text-surface-600 uppercase tracking-widest">Photo Coming Soon</span>
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
                      <div className="flex flex-wrap gap-1">
                        {(() => {
                          const reason = v.listings.facebook_marketplace.staleReason || '';
                          const parts = reason.split(',').filter(Boolean);
                          const badges = [];

                          for (const part of parts) {
                            const priceMatch = part.match(/price_changed:([\d.]+)->([\d.]+)/);
                            if (priceMatch) {
                              badges.push(`Price: $${Number(priceMatch[1]).toLocaleString()} → $${Number(priceMatch[2]).toLocaleString()}`);
                            } else if (part === 'photos_changed') {
                              badges.push('Photos Updated');
                            } else if (part === 'description_changed') {
                              badges.push('Description Updated');
                            } else {
                              badges.push('Needs Update');
                            }
                          }

                          if (badges.length === 0) badges.push('Needs Update');

                          return badges.map((text, i) => (
                            <Badge key={i} variant="warning" size="xs">
                              <AlertCircle size={8} className="mr-1" />
                              {text}
                            </Badge>
                          ));
                        })()}
                      </div>
                    )}                </div>

                <div className="absolute bottom-4 right-4 z-20">
                   <div className="px-3 py-1.5 bg-brand-500 text-white font-black text-sm rounded-lg shadow-glow-blue italic">
                     {formatPrice(v.price)}
                   </div>
                </div>
              </div>

              <div className="p-5 flex-1 flex flex-col">
                <div className="mb-4">
                  <h3 className="text-lg font-black text-white leading-tight group-hover:text-brand-400 transition-colors">
                    {v.year} {v.make} {v.model} {v.trim || ''}
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="flex items-center gap-1 px-3 py-2 bg-surface-950/50 border border-surface-800/50 rounded-xl text-xs font-black uppercase tracking-widest text-surface-400 hover:text-white hover:border-brand-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-surface-400 disabled:hover:border-surface-800/50"
          >
            <ChevronLeft size={14} />
            Prev
          </button>

          {pageNumbers.map((n, i) =>
            n === '...' ? (
              <span key={`ellipsis-${i}`} className="px-2 text-surface-600 text-xs">...</span>
            ) : (
              <button
                key={n}
                onClick={() => setPage(n)}
                className={`w-9 h-9 rounded-xl text-xs font-black uppercase transition-all ${
                  n === safePage
                    ? 'bg-brand-500 text-white shadow-glow-blue'
                    : 'bg-surface-950/50 border border-surface-800/50 text-surface-400 hover:text-white hover:border-brand-500/50'
                }`}
              >
                {n}
              </button>
            )
          )}

          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="flex items-center gap-1 px-3 py-2 bg-surface-950/50 border border-surface-800/50 rounded-xl text-xs font-black uppercase tracking-widest text-surface-400 hover:text-white hover:border-brand-500/50 transition-all disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-surface-400 disabled:hover:border-surface-800/50"
          >
            Next
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
