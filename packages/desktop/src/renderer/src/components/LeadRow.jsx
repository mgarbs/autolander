import { Link } from 'react-router-dom';
import Badge from './Badge';
import TimeAgo from './TimeAgo';
import { ChevronRight, MessageSquare, TrendingUp, Calendar, User } from 'lucide-react';
import { motion } from 'framer-motion';

export default function LeadRow({ lead }) {
  const score = lead.score || 0;
  const isHot = score >= 70;
  const isWarm = score >= 40 && score < 70;

  return (
    <motion.div
      whileHover={{ scale: 1.005, backgroundColor: 'rgba(255, 255, 255, 0.02)' }}
      className="group relative border-b border-surface-900/50 last:border-b-0"
    >
      <Link 
        to={`/leads/${lead.buyerId}`} 
        className="flex items-center gap-6 px-6 py-5 transition-all duration-300"
      >
        <div className="flex-shrink-0 relative group">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border-2 transition-transform duration-300 group-hover:rotate-12 ${
            isHot ? 'bg-rose-500/10 border-rose-500/30' : 
            isWarm ? 'bg-orange-500/10 border-orange-500/30' : 
            'bg-surface-800 border-surface-700'
          }`}>
            <User size={20} className={isHot ? 'text-rose-400' : isWarm ? 'text-orange-400' : 'text-surface-400'} />
          </div>
          {isHot && (
            <div className="absolute -right-1 -top-1 w-3 h-3 bg-rose-500 rounded-full border-2 border-surface-950 animate-pulse" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-sm font-semibold text-surface-100 truncate group-hover:text-brand-400 transition-colors">
              {lead.buyerName || 'Unknown Buyer'}
            </h3>
            {isHot && <Badge variant="hot" size="xs">Hot</Badge>}
            {lead.sentiment && (
              <Badge variant={lead.sentiment === 'positive' ? 'success' : 'default'} size="xs">
                {lead.sentiment}
              </Badge>
            )}
          </div>
          {lead.vehicleSummary && lead.vehicleSummary !== 'N/A' && (
            <p className="text-xs font-medium text-surface-400 mb-1 truncate">{lead.vehicleSummary}</p>
          )}
          <div className="flex items-center gap-4 text-xs font-medium text-surface-500">
            <div className="flex items-center gap-1.5">
              <MessageSquare size={12} className="text-brand-500/60" />
              <span>{lead.messages?.length || 0} messages</span>
            </div>
            {lead.lastMessageAt && (
              <div className="flex items-center gap-1.5">
                <Calendar size={12} className="text-surface-600" />
                <TimeAgo date={lead.lastMessageAt} />
              </div>
            )}
          </div>
        </div>

        <div className="hidden md:flex flex-col items-end gap-2 pr-4">
           <div className="flex items-center gap-2">
             <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest text-surface-600 font-bold">AI SCORE</div>
                <div className={`text-lg font-black italic tracking-tighter ${
                  isHot ? 'text-rose-500' : isWarm ? 'text-orange-500' : 'text-surface-400'
                }`}>
                  {score}%
                </div>
             </div>
             <TrendingUp size={16} className={isHot ? 'text-rose-500' : isWarm ? 'text-orange-500' : 'text-surface-700'} />
           </div>
        </div>

        <div className="flex-shrink-0 text-surface-700 group-hover:text-brand-500 transition-colors">
          <ChevronRight size={20} />
        </div>
      </Link>
    </motion.div>
  );
}
