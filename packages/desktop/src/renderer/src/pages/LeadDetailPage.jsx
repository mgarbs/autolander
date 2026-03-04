import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import LeadDetail from '../components/LeadDetail';
import { getLead } from '../api/client';
import { ArrowLeft, RefreshCw, AlertCircle } from 'lucide-react';
import { motion } from 'framer-motion';

export default function LeadDetailPage() {
  const { buyerId } = useParams();
  const navigate = useNavigate();
  const [lead, setLead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getLead(buyerId);
      setLead(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [buyerId]);

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/leads')}
          className="group flex items-center gap-2 text-xs font-black uppercase tracking-widest text-surface-500 hover:text-brand-400 transition-all"
        >
          <div className="p-2 rounded-xl bg-surface-900 border border-surface-800 group-hover:border-brand-500/30 group-hover:text-brand-400 group-hover:shadow-glow-blue transition-all">
            <ArrowLeft size={14} />
          </div>
          Back to Smart Pipeline
        </button>
        
        <button 
          onClick={load}
          className="p-2 rounded-xl bg-surface-900 border border-surface-800 text-surface-500 hover:text-white transition-all active:scale-95"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !lead ? (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
           <div className="w-12 h-12 border-2 border-brand-500 border-t-transparent rounded-full animate-spin shadow-glow-blue" />
           <span className="text-xs font-black uppercase tracking-[0.2em] text-surface-600">Analyzing Conversation...</span>
        </div>
      ) : error || !lead ? (
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="glass-card p-12 text-center max-w-lg mx-auto"
        >
          <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-6">
            <AlertCircle className="text-rose-500" size={32} />
          </div>
          <h2 className="text-xl font-black text-white mb-2 uppercase tracking-tight">Lead Synchronization Failed</h2>
          <p className="text-surface-500 text-sm mb-8 leading-relaxed">
            The lead data for <code className="text-brand-400 font-mono bg-surface-950 px-1.5 py-0.5 rounded">{buyerId}</code> could not be retrieved from the server.
          </p>
          <button
            onClick={() => navigate('/leads')}
            className="w-full py-3 bg-surface-900 border border-surface-800 rounded-xl text-xs font-black uppercase tracking-widest text-white hover:bg-surface-800 transition-all"
          >
            Return to Pipeline
          </button>
        </motion.div>
      ) : (
        <LeadDetail lead={lead} />
      )}
    </div>
  );
}
