import { useState, useEffect, useCallback } from 'react';
import StatsCard from '../components/StatsCard';
import PipelineBar from '../components/PipelineBar';
import LeadRow from '../components/LeadRow';
import { getStats, getLeads, getPipeline, getInventory } from '../api/client';
import { 
  Users, 
  Flame, 
  CalendarCheck, 
  CarFront, 
  ShieldCheck, 
  BarChart3, 
  CheckCircle2, 
  Clock, 
  History,
  LayoutGrid,
  TrendingUp,
  Activity,
  ArrowUpRight,
  AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function ManagerDashboard() {
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [pipeline, setPipeline] = useState({ hot: 0, warm: 0, cold: 0, dead: 0 });
  const [inventory, setInventory] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, l, p, inv] = await Promise.all([
        getStats(),
        getLeads({}),
        getPipeline(),
        getInventory()
      ]);
      setStats(s);
      setLeads(l);
      setPipeline(p);
      setInventory(inv);
    } catch (e) {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  const totalActive = (pipeline.hot || 0) + (pipeline.warm || 0) + (pipeline.cold || 0);
  const vehicles = inventory?.vehicles || [];
  const available = vehicles.filter(v => v.status === 'available').length;
  const posted = vehicles.filter(v => v.listings?.facebook_marketplace?.posted).length;
  const staleCount = vehicles.filter(v => v.listings?.facebook_marketplace?.stale).length;

  return (
    <div className="space-y-10 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-emerald-500 font-bold text-xs uppercase tracking-widest">
            <ShieldCheck size={14} />
            Management Overview
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
            Control <span className="text-brand-500">Center</span>
          </h1>
          <p className="text-surface-500 font-medium">Team-wide performance and inventory overview</p>
        </div>
        
        <div className="flex items-center gap-4 bg-surface-900/50 p-1.5 rounded-2xl border border-surface-800">
           <div className="flex items-center gap-2 px-4 py-2 bg-surface-800 rounded-xl text-xs font-bold text-white shadow-lg">
             <Activity size={14} className="text-emerald-500" />
             LIVE UPDATES
           </div>
        </div>
      </header>

      {/* Primary Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-6">
        <StatsCard label="TEAM LEADS" value={totalActive} icon={Users} highlight />
        <StatsCard label="HOT LEADS" value={pipeline.hot || 0} icon={Flame} />
        <StatsCard label="APPOINTMENTS" value={stats?.todayAppointments || 0} subtext="Today" icon={CalendarCheck} />
        <StatsCard label="VEHICLES" value={vehicles.length} subtext={`${available} available`} icon={CarFront} />
        <StatsCard label="FB POSTS" value={posted} subtext={`${Math.round((posted/vehicles.length)*100)}% coverage`} icon={ArrowUpRight} />
        <StatsCard label="STALE" value={staleCount} subtext="Need update" icon={AlertCircle} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column - Team Pipeline */}
        <div className="lg:col-span-4 space-y-8">
          <div className="glass-card p-6 border-l-4 border-l-brand-500 h-fit">
            <div className="flex items-center justify-between mb-8">
               <h2 className="text-sm font-black uppercase tracking-widest text-surface-500 flex items-center gap-2">
                 <BarChart3 size={16} className="text-brand-500" />
                 TEAM PIPELINE
               </h2>
               <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-brand-500/10 text-brand-400 text-[10px] font-black uppercase tracking-widest">
                  <TrendingUp size={10} />
                  HEALTHY
               </div>
            </div>
            <PipelineBar pipeline={pipeline} />
          </div>

          <div className="glass-card p-6">
            <h2 className="text-sm font-black uppercase tracking-widest text-surface-500 mb-6 flex items-center gap-2">
               <CarFront size={16} className="text-brand-500" />
               INVENTORY SUMMARY
            </h2>
            <div className="grid grid-cols-2 gap-4">
               {[
                 { label: 'Available', value: available, color: 'text-emerald-400', icon: CheckCircle2 },
                 { label: 'Pending', value: vehicles.filter(v => v.status === 'pending').length, color: 'text-amber-400', icon: Clock },
                 { label: 'Sold', value: vehicles.filter(v => v.status === 'sold').length, color: 'text-blue-400', icon: History },
                 { label: 'Posted', value: posted, color: 'text-brand-400', icon: ShieldCheck },
                 { label: 'Stale', value: staleCount, color: 'text-amber-400', icon: AlertCircle }
               ].map((item, idx) => (
                 <div key={idx} className="bg-surface-950/50 p-4 rounded-2xl border border-surface-800 flex flex-col items-center text-center">
                    <item.icon size={16} className={`${item.color} mb-3`} />
                    <span className="text-2xl font-black text-white">{item.value}</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-surface-600">{item.label}</span>
                 </div>
               ))}
            </div>
          </div>
        </div>

        {/* Right Column - Top Leads */}
        <div className="lg:col-span-8 space-y-6">
          <div className="glass-card overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-surface-900/50">
               <div className="flex items-center gap-3">
                  <Flame size={18} className="text-rose-500" />
                  <h2 className="text-lg font-bold text-white tracking-tight">Priority Leads (By Score)</h2>
               </div>
               <button className="text-xs font-bold text-brand-500 hover:text-brand-400 transition-colors">
                 VIEW ALL LEADS
               </button>
            </div>
            
            <div className="min-h-[400px]">
              {loading ? (
                <div className="flex flex-col items-center justify-center p-20 gap-4 opacity-50">
                  <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs font-bold uppercase tracking-widest text-surface-600">Loading Leads...</span>
                </div>
              ) : leads.length === 0 ? (
                <div className="p-20 text-center opacity-50">
                   <p className="text-sm font-bold text-surface-400 uppercase tracking-widest">No active leads</p>
                </div>
              ) : (
                leads.slice(0, 10).map(lead => (
                  <LeadRow key={lead.buyerId} lead={lead} onRefresh={refresh} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
