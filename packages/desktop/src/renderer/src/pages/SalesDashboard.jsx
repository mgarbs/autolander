import { useState, useEffect, useCallback, useRef } from 'react';
import StatsCard from '../components/StatsCard';
import PipelineBar from '../components/PipelineBar';
import FilterTabs from '../components/FilterTabs';
import LeadRow from '../components/LeadRow';
import Badge from '../components/Badge';
import TimeAgo from '../components/TimeAgo';
import { getStats, getLeads, getPipeline, archiveConversation } from '../api/client';
import { useRealtime } from '../context/RealtimeContext';
import { useAgent } from '../context/AgentContext';
import {
  Users,
  Flame,
  CalendarCheck,
  CarFront,
  Search,
  RefreshCw,
  TrendingUp,
  LayoutGrid,
  List,
  Zap,
  Clock,
  Skull,
  Trash2,
  MessageSquare,
  ShieldCheck,
  ShieldAlert
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';

export default function SalesDashboard() {
  const navigate = useNavigate();
  const { connected, lastEvents } = useRealtime();
  const agent = useAgent();
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [pipeline, setPipeline] = useState({ hot: 0, warm: 0, cold: 0, dead: 0 });
  const [filter, setFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState('list');

  const abortRef = useRef(null);

  const refresh = useCallback(async (signal) => {
    try {
      const opts = signal ? { signal } : {};
      const [s, l, p] = await Promise.all([
        getStats(opts),
        getLeads(filter ? { sentiment: filter } : {}, opts),
        getPipeline(opts)
      ]);
      setStats(s);
      setLeads(l);
      setPipeline(p);
    } catch (e) {
      if (e.name === 'AbortError') return;
    } finally {
      setLoading(false);
    }
  }, [filter]);

  const handleArchive = async (e, lead) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.confirm(`Archive this conversation with ${lead.buyerName || 'this buyer'}?`)) {
      try {
        await archiveConversation(lead.id || lead.buyerId);
        await refresh();
      } catch (err) {
        console.error('Failed to archive:', err);
        alert('Failed to archive conversation');
      }
    }
  };

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    refresh(ac.signal);
    const interval = setInterval(() => {
      const ic = new AbortController();
      abortRef.current = ic;
      refresh(ic.signal);
    }, 30000);
    return () => { ac.abort(); clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (lastEvents.lead) {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      refresh(ac.signal);
    }
  }, [lastEvents.lead, refresh]);

  const kanbanColumns = [
    { key: 'hot', label: 'Priority / Hot', icon: Flame, color: 'text-rose-500', bg: 'bg-rose-500/5', border: 'border-rose-500/10' },
    { key: 'warm', label: 'In Progress', icon: Zap, color: 'text-orange-500', bg: 'bg-orange-500/5', border: 'border-orange-500/10' },
    { key: 'cold', label: 'Follow Up', icon: Clock, color: 'text-indigo-500', bg: 'bg-indigo-500/5', border: 'border-indigo-500/10' },
    { key: 'dead', label: 'Archived', icon: Skull, color: 'text-surface-600', bg: 'bg-surface-900/10', border: 'border-surface-800/10' }
  ];

  const getLeadsByStatus = (status) => {
    return leads.filter(l => {
      const s = l.score || 0;
      if (status === 'hot') return s >= 70;
      if (status === 'warm') return s >= 40 && s < 70;
      if (status === 'cold') return s > 0 && s < 40;
      if (status === 'dead') return s === 0;
      return false;
    });
  };

  const hotCount = pipeline.hot || 0;
  const activeCount = (pipeline.hot || 0) + (pipeline.warm || 0) + (pipeline.cold || 0);

  const filteredLeads = leads.filter(l =>
    l.buyerName?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-10 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
              <TrendingUp size={14} />
              Performance Overview
            </div>
            {connected && (
              <div className="flex items-center gap-2 px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shadow-glow-green" />
                <span className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Live</span>
              </div>
            )}
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none">
            SALES <span className="text-brand-500">HUB</span>
          </h1>
          <p className="text-surface-500 font-medium">Tracking {activeCount} active sales opportunities</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Agent Polling Status Panel */}
          <div className="flex items-center gap-3 px-4 py-2 bg-surface-900/50 border border-surface-800 rounded-2xl mr-2">
            <div className="flex flex-col gap-0.5">
               <div className="flex items-center gap-2">
                 <div className={`w-1.5 h-1.5 rounded-full ${agent?.inbox?.running ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                 <span className="text-[10px] font-black text-white uppercase tracking-wider">
                   {agent?.inbox?.running ? 'AI Active' : 'AI Offline'}
                 </span>
               </div>
               <div className="flex items-center gap-3 text-[9px] font-bold text-surface-500 uppercase tracking-tighter">
                 <span className="flex items-center gap-1">
                   {agent?.fbSessionValid ? (
                     <ShieldCheck size={10} className="text-emerald-500" />
                   ) : (
                     <ShieldAlert size={10} className="text-rose-500" />
                   )}
                   FB: {agent?.fbSessionValid ? 'OK' : 'ERR'}
                 </span>
                 <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {agent?.inbox?.lastPoll ? <TimeAgo date={agent.inbox.lastPoll} className="" /> : 'Never'}
                 </span>
                 <span className="flex items-center gap-1">
                    <MessageSquare size={10} />
                    {agent?.inbox?.messagesForwarded || 0} SENT
                 </span>
               </div>
            </div>
          </div>

          <div className="flex bg-surface-900 p-1 rounded-xl border border-surface-800 mr-2">
             <button
               onClick={() => setViewMode('kanban')}
               className={`p-2 rounded-lg transition-all ${viewMode === 'kanban' ? 'bg-surface-800 text-white shadow-lg' : 'text-surface-500 hover:text-surface-300'}`}
             >
               <LayoutGrid size={18} />
             </button>
             <button
               onClick={() => setViewMode('list')}
               className={`p-2 rounded-lg transition-all ${viewMode === 'list' ? 'bg-surface-800 text-white shadow-lg' : 'text-surface-500 hover:text-surface-300'}`}
             >
               <List size={18} />
             </button>
          </div>

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
          subtext="Upcoming"
        />
        <StatsCard
          label="INVENTORY"
          value={stats?.vehicles || 0}
          icon={CarFront}
          subtext={`${stats?.posted || 0} active listings`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Main Content - Leads */}
        <div className="lg:col-span-8 space-y-6">
          {viewMode === 'list' ? (
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
                      <LeadRow key={lead.buyerId} lead={lead} onRefresh={refresh} />
                    ))
                  )}
                </AnimatePresence>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {kanbanColumns.map((column) => {
                const columnLeads = getLeadsByStatus(column.key).filter(l =>
                  l.buyerName?.toLowerCase().includes(searchQuery.toLowerCase())
                );
                return (
                  <div key={column.key} className="flex flex-col gap-4 min-w-0">
                    <div className={`flex items-center justify-between p-4 rounded-2xl border ${column.bg} ${column.border}`}>
                      <div className="flex items-center gap-3">
                        <column.icon size={18} className={column.color} />
                        <h3 className="text-xs font-black uppercase tracking-widest text-surface-100 truncate">
                          {column.label}
                        </h3>
                      </div>
                      <Badge variant={column.key === 'hot' ? 'hot' : 'default'} size="xs">
                        {columnLeads.length}
                      </Badge>
                    </div>

                    <div className="flex flex-col gap-4 min-h-[200px]">
                      {loading ? (
                        <div className="h-20 glass-card animate-pulse opacity-50" />
                      ) : columnLeads.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-8 text-center opacity-30 border-2 border-dashed border-surface-900 rounded-3xl">
                          <column.icon size={24} className="mb-2" />
                          <span className="text-[10px] font-bold uppercase tracking-widest">No Leads</span>
                        </div>
                      ) : (
                        columnLeads.map(lead => (
                          <motion.div
                            key={lead.buyerId}
                            layout
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            onClick={() => navigate(`/leads/${lead.buyerId}`)}
                            className="glass-card p-4 hover:border-brand-500/30 transition-all cursor-pointer group relative"
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div className="font-bold text-sm text-surface-100 group-hover:text-brand-400 transition-colors truncate">
                                {lead.buyerName || 'Unknown'}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={(e) => handleArchive(e, lead)}
                                  className="flex items-center gap-2 text-rose-500 border border-rose-500/30 hover:bg-rose-500/10 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-colors"
                                  title="Archive"
                                >
                                  <Trash2 size={12} />
                                  <span>Delete</span>
                                </button>
                                <div className={`text-[10px] font-black italic ${column.color}`}>
                                  {lead.score || 0}%
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mb-4">
                              <Badge variant={lead.sentiment === 'positive' ? 'success' : 'default'} size="xs">
                                {lead.sentiment || 'neutral'}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between text-[10px] font-bold text-surface-600 uppercase tracking-widest border-t border-surface-900/50 pt-3">
                                <span className="flex items-center gap-1.5">
                                  <RefreshCw size={10} />
                                  {lead.messages?.length || 0} MSG
                                </span>
                                {lead.vehicleInfo?.model && (
                                  <span className="truncate max-w-[80px]">
                                    {lead.vehicleInfo.year} {lead.vehicleInfo.model}
                                  </span>
                                )}
                            </div>
                          </motion.div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
        </div>
      </div>
    </div>
  );
}
