import { useState, useEffect, useCallback } from 'react';
import PipelineBar from '../components/PipelineBar';
import FilterTabs from '../components/FilterTabs';
import LeadRow from '../components/LeadRow';
import Badge from '../components/Badge';
import { getLeads, getPipeline, rescoreLeads } from '../api/client';
import { 
  GitBranch, 
  RefreshCw, 
  LayoutGrid, 
  List, 
  ArrowRightLeft,
  Flame,
  Zap,
  Clock,
  Skull,
  Search,
  Filter
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function LeadPipeline() {
  const [leads, setLeads] = useState([]);
  const [pipeline, setPipeline] = useState({ hot: 0, warm: 0, cold: 0, dead: 0 });
  const [filter, setFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rescoring, setRescoring] = useState(false);
  const [viewMode, setViewMode] = useState('kanban'); // 'kanban' or 'list'

  const refresh = useCallback(async () => {
    try {
      const [l, p] = await Promise.all([
        getLeads(filter ? { sentiment: filter } : {}),
        getPipeline()
      ]);
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

  const handleRescore = async () => {
    setRescoring(true);
    try {
      await rescoreLeads();
      await refresh();
    } finally {
      setRescoring(false);
    }
  };

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

  return (
    <div className="space-y-8 pb-12">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-brand-500 font-bold text-xs uppercase tracking-widest">
            <GitBranch size={14} />
            AI Pipeline Engine
          </div>
          <h1 className="text-4xl font-black text-white tracking-tight leading-none uppercase">
            Lead <span className="text-brand-500">Flow</span>
          </h1>
          <p className="text-surface-500 font-medium">Managing {leads.length} conversations across all stages</p>
        </div>
        
        <div className="flex items-center gap-3">
          <div className="flex bg-surface-900 p-1 rounded-xl border border-surface-800">
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
            onClick={handleRescore}
            disabled={rescoring}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-800 text-white text-xs font-black uppercase tracking-widest rounded-xl transition-all shadow-glow-blue active:scale-95"
          >
            <ArrowRightLeft size={14} className={rescoring ? 'animate-spin' : ''} />
            {rescoring ? 'Calculating...' : 'Recalibrate AI Scores'}
          </button>
        </div>
      </header>

      {/* Summary Section */}
      <section className="glass-card p-6">
         <div className="flex items-center justify-between mb-6">
            <h2 className="text-[10px] font-black uppercase tracking-[0.2em] text-surface-500">Global Health Indicator</h2>
            <div className="flex gap-4">
               {kanbanColumns.map(col => (
                 <div key={col.key} className="flex items-center gap-2">
                   <div className={`w-1.5 h-1.5 rounded-full ${col.color.replace('text', 'bg')}`} />
                   <span className="text-[10px] font-bold text-surface-400 uppercase tracking-widest">{col.label}</span>
                   <span className="text-[10px] font-black text-surface-100">{getLeadsByStatus(col.key).length}</span>
                 </div>
               ))}
            </div>
         </div>
         <PipelineBar pipeline={pipeline} />
      </section>

      {viewMode === 'kanban' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-start">
          {kanbanColumns.map((column) => {
            const columnLeads = getLeadsByStatus(column.key);
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
                
                <div className="flex flex-col gap-4 min-h-[500px]">
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
                         className="glass-card p-4 hover:border-brand-500/30 transition-all cursor-pointer group"
                       >
                         <div className="flex items-start justify-between mb-3">
                           <div className="font-bold text-sm text-surface-100 group-hover:text-brand-400 transition-colors truncate">
                             {lead.buyerName || 'Unknown'}
                           </div>
                           <div className={`text-[10px] font-black italic ${column.color}`}>
                             {lead.score}%
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
      ) : (
        <div className="glass-card overflow-hidden">
           <div className="flex items-center justify-between p-6 border-b border-surface-900/50">
              <div className="flex items-center gap-3">
                 <Search size={14} className="text-surface-600" />
                 <input 
                   type="text" 
                   placeholder="Filter by name..." 
                   className="bg-transparent border-none outline-none text-xs font-bold uppercase tracking-widest text-surface-100 placeholder:text-surface-700"
                 />
              </div>
              <FilterTabs active={filter} onChange={setFilter} />
           </div>
           <div>
              {loading ? (
                <div className="p-20 text-center opacity-50">
                  <RefreshCw className="animate-spin mx-auto mb-4" />
                  <span className="text-xs font-black uppercase tracking-widest">Syncing Pipeline...</span>
                </div>
              ) : leads.length === 0 ? (
                <div className="p-20 text-center opacity-30">
                  <Skull size={48} className="mx-auto mb-4" />
                  <p className="text-sm font-bold uppercase tracking-widest">The pipeline is empty</p>
                </div>
              ) : (
                leads.map(lead => <LeadRow key={lead.buyerId} lead={lead} />)
              )}
           </div>
        </div>
      )}
    </div>
  );
}
