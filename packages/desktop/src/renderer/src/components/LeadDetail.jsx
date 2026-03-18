import Badge from './Badge';
import ScoreBreakdown from './ScoreBreakdown';
import TimeAgo from './TimeAgo';
import {
  User,
  MessageSquare,
  CarFront,
  ShieldCheck,
  BrainCircuit,
  Activity,
  History,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  Flame,
  Zap,
  TrendingUp,
  MapPin,
  Phone,
  Mail,
  Calendar,
  DollarSign,
  ArrowRightLeft
} from 'lucide-react';
import { motion } from 'framer-motion';

export default function LeadDetail({ lead }) {
  if (!lead) return null;

  const score = lead.leadScore || {};
  const signals = score.signals || [];
  const isHot = (score.sentimentScore || 0) >= 70;

  const financingPreference = lead.financingType || 'Unknown';
  const tradeInVehicle = lead.tradeInDescription || 'None mentioned';
  console.log('[LeadDetail] tradeInDescription:', lead.tradeInDescription, 'financingType:', lead.financingType);

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Hero Header */}
      <section className="glass-card overflow-hidden border-l-4 border-brand-500">
        <div className="p-8 flex flex-col md:flex-row md:items-center justify-between gap-8 relative">
          {/* Subtle Background Glow */}
          <div className="absolute right-0 top-0 w-64 h-64 bg-brand-500 blur-[100px] opacity-10 rounded-full" />

          <div className="flex items-center gap-6 relative z-10">
             <div className={`w-20 h-20 rounded-3xl flex items-center justify-center border-2 transition-all duration-500 ${
               isHot ? 'bg-rose-500/10 border-rose-500/30 rotate-3' : 'bg-surface-800 border-surface-700'
             }`}>
               <User size={32} className={isHot ? 'text-rose-500' : 'text-brand-500'} />
             </div>

             <div>
                <div className="flex items-center gap-3 mb-2">
                  <h1 className="text-3xl font-black text-white tracking-tighter uppercase leading-none">
                    {lead.buyerName || 'Buyer Unit ' + lead.buyerId?.slice(-4)} 
                  </h1>
                  {isHot && <Badge variant="hot" size="md">HOT OPPORTUNITY</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                   <p className="text-brand-400 font-black text-sm uppercase tracking-widest flex items-center gap-2">
                     <CarFront size={14} />
                     {lead.vehicleSummary || 'N/A'}
                   </p>
                   <span className="text-surface-700 font-black text-sm">/</span>
                   <p className="text-surface-500 font-bold text-xs uppercase tracking-[0.15em] flex items-center gap-2">
                     <MapPin size={12} className="text-surface-600" />
                     {lead.buyerId || 'No ID'}
                   </p>
                </div>
             </div>
          </div>

          <div className="flex items-center gap-6 relative z-10 bg-surface-950/40 p-4 rounded-2xl border border-surface-900/50 backdrop-blur-sm">
             <div className="text-center px-4 border-r border-surface-900/50">  
                <div className="text-[10px] font-black uppercase tracking-widest text-surface-500 mb-1">AI SCORE</div>
                <div className={`text-4xl font-black italic tracking-tighter ${ 
                  isHot ? 'text-rose-500 animate-pulse' : 'text-brand-500'      
                }`}>
                  {score.sentimentScore || 0}%
                </div>
             </div>
             <div className="text-center px-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-surface-500 mb-1">SENTIMENT</div>
                <Badge variant={score.sentiment === 'positive' ? 'success' : 'default'} size="md">
                   {score.sentiment || 'NEUTRAL'}
                </Badge>
             </div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column - AI Intelligence */}
        <div className="lg:col-span-8 space-y-8">
          {/* Intelligence Score Breakdown */}
          <div className="glass-card p-6">
            <div className="flex items-center justify-between mb-8">
               <h3 className="text-sm font-black uppercase tracking-[0.2em] text-surface-500 flex items-center gap-2">
                 <BrainCircuit size={18} className="text-brand-500" />
                 AI Scoring Diagnostics
               </h3>
               <div className="px-3 py-1 rounded-full bg-brand-500/10 text-brand-400 text-[10px] font-black uppercase tracking-widest border border-brand-500/20">
                  REAL-TIME ANALYSIS
               </div>
            </div>
            <ScoreBreakdown breakdown={score.breakdown} score={score.sentimentScore} />
          </div>

          {/* Conversation Transcript */}
          <div className="glass-card overflow-hidden">
            <div className="p-6 border-b border-surface-900/50 flex items-center justify-between bg-surface-900/10">
               <h3 className="text-sm font-black uppercase tracking-[0.2em] text-surface-500 flex items-center gap-2">
                 <MessageSquare size={18} className="text-brand-500" />
                 Communication Transcript
               </h3>
               <button className="text-[10px] font-black uppercase tracking-widest text-brand-500 flex items-center gap-1.5 hover:text-brand-400 transition-colors">
                  <ExternalLink size={12} />
                  SYNC WITH MESSENGER
               </button>
            </div>

            <div className="p-6 space-y-6 max-h-[500px] overflow-y-auto bg-surface-950/20">
              {lead.messages?.length > 0 ? (
                lead.messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'buyer' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[80%] rounded-2xl p-4 text-sm font-medium leading-relaxed relative ${
                      msg.role === 'buyer'
                        ? 'bg-surface-900 border border-surface-800 text-surface-200 rounded-bl-none'
                        : 'bg-brand-600 border border-brand-500/50 text-white rounded-br-none shadow-glow-blue'
                    }`}>
                      <p className="mb-1">{msg.text}</p>
                      <div className={`text-[9px] font-bold uppercase tracking-widest ${
                        msg.role === 'buyer' ? 'text-surface-600' : 'text-brand-200/60'
                      }`}>
                        {msg.role === 'buyer' ? lead.buyerName || 'BUYER' : 'AI RESPONSE'} &middot; {new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>

                      {/* Message Tail */}
                      <div className={`absolute bottom-0 w-4 h-4 ${
                        msg.role === 'buyer'
                          ? 'left-[-8px] border-b-[16px] border-b-surface-900 border-l-[16px] border-l-transparent'
                          : 'right-[-8px] border-b-[16px] border-b-brand-600 border-r-[16px] border-r-transparent'
                      }`} />
                    </div>
                  </div>
                ))
              ) : (
                <div className="py-20 text-center opacity-30">
                   <p className="text-xs font-black uppercase tracking-widest">No Transcript Available</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - Context & Signals */}
        <div className="lg:col-span-4 space-y-8">
          {/* Customer Intel Card */}
          <div className="glass-card p-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-surface-500 mb-6 flex items-center gap-2">
               CUSTOMER INTEL
            </h3>
            <div className="space-y-4">
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-surface-500">
                     <Phone size={12} className="text-brand-500" />
                     Phone
                  </div>
                  <div className="text-xs font-bold text-surface-200">
                     {lead.buyerPhone || 'Not captured'}
                  </div>
               </div>
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-surface-500">
                     <Mail size={12} className="text-brand-500" />
                     Email
                  </div>
                  <div className="text-xs font-bold text-surface-200">
                     {lead.buyerEmail || 'Not captured'}
                  </div>
               </div>
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-surface-500">
                     <Calendar size={12} className="text-brand-500" />
                     Appointment
                  </div>
                  <div className="text-xs font-bold text-surface-200">
                     {lead.appointment ? (
                       <span className="text-emerald-500 font-black">
                         {new Date(lead.appointment.scheduledTime).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at {new Date(lead.appointment.scheduledTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                       </span>
                     ) : (
                       'None scheduled'
                     )}
                  </div>
               </div>
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-surface-500">
                     <DollarSign size={12} className="text-brand-500" />
                     Financing
                  </div>
                  <div className="text-xs font-bold text-surface-200">
                     {financingPreference}
                  </div>
               </div>
               <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-surface-500">
                     <ArrowRightLeft size={12} className="text-brand-500" />
                     Trade-in
                  </div>
                  <div className="text-xs font-bold text-surface-200 truncate max-w-[150px]" title={tradeInVehicle}>
                     {tradeInVehicle}
                  </div>
               </div>
            </div>
          </div>

          {/* Summary Widget */}
          <div className="glass-card p-6 bg-brand-500/5 border-l-4 border-l-brand-500">
             <h3 className="text-xs font-black uppercase tracking-widest text-brand-500 mb-4 flex items-center gap-2">
                <Activity size={14} />
                AI Executive Summary
             </h3>
             <p className="text-xs text-surface-400 font-medium leading-relaxed italic">
                "{score.summary || 'AI Analysis pending. Monitor conversation for intent signals.'}"
             </p>
          </div>

          {/* Signals Widget */}
          <div className="glass-card p-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-surface-500 mb-6 flex items-center justify-between">
               INTENT SIGNALS
               <Badge variant="brand" size="xs">{signals.length}</Badge>        
            </h3>
            <div className="space-y-3">
              {signals.length > 0 ? (
                signals.map((s, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-surface-900/50 border border-surface-800 transition-all hover:border-surface-700">
                    <div className="flex flex-col gap-0.5 min-w-0">
                       <span className="text-[10px] font-black uppercase tracking-widest text-surface-500 leading-none">
                         {s.weight > 0 ? 'POSITIVE' : 'NEGATIVE'}
                       </span>
                       <span className="text-xs font-bold text-surface-200 truncate pr-2">
                         {s.description}
                       </span>
                    </div>
                    <div className={`text-xs font-black italic px-2 py-1 rounded-lg ${
                      s.weight > 0 ? 'text-emerald-500 bg-emerald-500/10' : 'text-rose-500 bg-rose-500/10'
                    }`}>
                      {s.weight > 0 ? '+' : ''}{s.weight}
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-10 text-center opacity-30">
                   <span className="text-[10px] font-black uppercase tracking-widest">Scanning for signals...</span>
                </div>
              )}
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="glass-card p-6">
            <h3 className="text-xs font-black uppercase tracking-widest text-surface-500 mb-6 flex items-center gap-2">
               METADATA & STATE
            </h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Lead Since', value: lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : 'N/A', icon: Clock, color: 'text-brand-500' },
                { label: 'Current State', value: lead.state || 'ACTIVE', icon: Activity, color: 'text-emerald-500' },
                { label: 'Msg Volume', value: lead.messageCount || 0, icon: MessageSquare, color: 'text-indigo-500' },
                { label: 'Engagement', value: lead.sentimentScore > 50 ? 'HIGH' : 'LOW', icon: TrendingUp, color: isHot ? 'text-rose-500' : 'text-surface-600' }
              ].map((item, i) => (
                <div key={i} className="bg-surface-950/50 p-3 rounded-xl border border-surface-900/50">
                   <div className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-surface-600 mb-1.5">
                      <item.icon size={10} className={item.color} />
                      {item.label}
                   </div>
                   <div className="text-xs font-black text-white uppercase truncate">
                      {item.value}
                   </div>
                </div>
              ))}
            </div>

            <div className="mt-6 pt-6 border-t border-surface-900/50">
               <div className="flex items-center justify-between text-[10px] font-bold text-surface-600 uppercase tracking-widest">
                  <span className="flex items-center gap-1.5">
                    <History size={12} />
                    Last Updated
                  </span>
                  <TimeAgo date={lead.lastMessageAt} />
               </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
