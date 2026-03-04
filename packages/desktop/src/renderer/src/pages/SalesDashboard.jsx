import { useState, useEffect, useCallback } from 'react';
import StatsCard from '../components/StatsCard';
import PipelineBar from '../components/PipelineBar';
import FilterTabs from '../components/FilterTabs';
import LeadRow from '../components/LeadRow';
import { getStats, getLeads, getPipeline } from '../api/client';
import { 
  Users, 
  Flame, 
  CalendarCheck, 
  CarFront, 
  Search,
  RefreshCw,
  TrendingUp,
  LayoutGrid,
  List
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function SalesDashboard() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [pipeline, setPipeline] = useState({ hot: 0, warm: 0, cold: 0, dead: 0 });
  const [filter, setFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, l, p] = await Promise.all([
        getStats(),
        getLeads(filter ? { sentiment: filter } : {}),
        getPipeline()
      ]);
      setStats(s);
      setLeads(l);
      setPipeline(p);
    } catch (e) {
      // silent
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const hotCount = pipeline.hot || 0;
  const activeCount = (pipeline.hot || 0) + (pipeline.warm || 0) + (pipeline.cold || 0);

  const filteredLeads = leads.filter(l => 
    l.buyerName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-10 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <TrendingUp size={14} />
            Performance Overview
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none">
            SALES <span className="text-brand-500">HUB</span>
          </h1>
          <p className="text-surface-500 font-medium">Tracking {activeCount} active sales opportunities</p>
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => { setLoading(true); refresh(); }}
            className="flex items-center gap-2 px-4 py-2.5 bg-surface-900 border border-surface-800 rounded-xl text-xs font-bold text-surface-400 hover:text-white hover:border-surface-700 transition-all active:scale-95"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            REFRESH DATA
          </button>
        </div>
      </header>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatsCard 
          label="ACTIVE LEADS" 
          value={activeCount} 
          icon={Users}
          highlight 
          trend="up"
          trendValue={12}
        />
        <StatsCard 
          label="HOT LEADS" 
          value={hotCount} 
          icon={Flame}
          subtext="Score ≥ 70" 
        />
        <StatsCard
          label="APPOINTMENTS"
          value={stats?.todayAppointments || 0}
          icon={CalendarCheck}
          subtext="Scheduled for today"
        />
        <StatsCard
          label="INVENTORY"
          value={stats?.vehicles || 0}
          icon={CarFront}
          subtext={`${stats?.posted || 0} active listings`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column - Leads */}
        <div className="lg:col-span-8 space-y-6">
          <div className="glass-card overflow-hidden">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 border-b border-surface-900/50">
              <div className="flex items-center gap-3">
                <List size={18} className="text-brand-500" />
                <h2 className="text-lg font-bold text-white tracking-tight">Recent Opportunities</h2>
              </div>
              
              <div className="flex items-center gap-3">
                <div className="relative group">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-600 group-focus-within:text-brand-500 transition-colors" />
                  <input 
                    type="text" 
                    placeholder="Search leads..."
                    className="pl-9 pr-4 py-2 bg-surface-950/50 border border-surface-800 rounded-lg text-xs font-medium focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/20 transition-all w-48"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <FilterTabs active={filter} onChange={setFilter} />
              </div>
            </div>

            <div className="min-h-[400px]">
              <AnimatePresence mode="popLayout">
                {loading ? (
                  <div className="flex flex-col items-center justify-center p-20 gap-4 opacity-50">
                    <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs font-bold uppercase tracking-widest text-surface-600">Syncing CRM...</span>
                  </div>
                ) : filteredLeads.length === 0 ? (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-col items-center justify-center p-20 gap-4 opacity-50 text-center"
                  >
                    <div className="w-16 h-16 rounded-full bg-surface-900 flex items-center justify-center border border-surface-800">
                      <Search size={24} className="text-surface-700" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-surface-400">No matching leads found</p>
                      <p className="text-xs text-surface-600">Try adjusting your filters or search query</p>
                    </div>
                  </motion.div>
                ) : (
                  filteredLeads.map(lead => (
                    <LeadRow key={lead.buyerId} lead={lead} />
                  ))
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Right Column - Sidebar Widgets */}
        <div className="lg:col-span-4 space-y-8">
          <section className="glass-card p-6 border-l-4 border-l-brand-500">
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-surface-500 mb-6 flex items-center justify-between">
              Lead Health
              <div className="w-1 h-1 rounded-full bg-brand-500 shadow-glow-blue" />
            </h2>
            <PipelineBar pipeline={pipeline} />
          </section>

          <section className="glass-card p-6">
            <h2 className="text-xs font-black uppercase tracking-[0.2em] text-surface-500 mb-4">
              AI Insights
            </h2>
            <div className="space-y-4">
               <div className="p-4 bg-brand-500/5 border border-brand-500/10 rounded-2xl">
                 <p className="text-xs font-semibold text-brand-400 mb-2 flex items-center gap-2">
                   <Flame size={12} />
                   HIGH INTEREST DETECTED
                 </p>
                 <p className="text-xs text-surface-400 leading-relaxed font-medium">
                   3 leads have mentioned financing in the last 2 hours. Consider prioritizing these conversations.
                 </p>
               </div>
               
               <div className="p-4 bg-surface-950/50 border border-surface-800 rounded-2xl">
                 <p className="text-xs font-semibold text-surface-400 mb-2 flex items-center gap-2">
                   <CalendarCheck size={12} />
                   SCHEDULING TIP
                 </p>
                 <p className="text-xs text-surface-500 leading-relaxed font-medium">
                   Mornings are seeing 40% higher response rates for appointment confirmations.
                 </p>
               </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
