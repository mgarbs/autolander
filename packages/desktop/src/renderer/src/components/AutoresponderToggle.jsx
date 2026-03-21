import React, { useState } from 'react';
import { Play, Pause, Bot, BotOff, Loader2 } from 'lucide-react';
import { useAgent } from '../context/AgentContext';
import { pauseAutoresponder, resumeAutoresponder } from '../api/client';

export default function AutoresponderToggle() {
  const { inbox, connected, refreshStatus } = useAgent();
  const [isToggling, setIsToggling] = useState(false);
  
  // The paused state comes from agentStatus.inbox.paused (boolean)
  const isPaused = inbox?.paused;
  const isRunning = inbox?.running;

  const handleToggle = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (isToggling || !connected) return;
    
    setIsToggling(true);
    try {
      if (isPaused) {
        await resumeAutoresponder();
      } else {
        await pauseAutoresponder();
      }
      // Refresh status to reflect change immediately
      if (refreshStatus) await refreshStatus();
    } catch (err) {
      console.error('Failed to toggle autoresponder:', err);
    } finally {
      setIsToggling(false);
    }
  };

  // If not connected, show as offline/disabled
  if (!connected) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-surface-900/50 text-surface-600 border border-surface-800 text-[10px] font-black uppercase tracking-widest cursor-not-allowed">
        <BotOff size={14} />
        <span>Agent Offline</span>
      </div>
    );
  }

  return (
    <button
      onClick={handleToggle}
      disabled={isToggling}
      className={`
        relative flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest transition-all duration-300
        ${isPaused 
          ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/20' 
          : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20'
        }
        ${isToggling ? 'opacity-80 cursor-wait' : 'cursor-pointer active:scale-95'}
      `}
      title={isPaused ? 'Resume Autoresponder' : 'Pause Autoresponder'}
    >
      <div className="relative flex items-center justify-center">
        {isToggling ? (
          <Loader2 size={14} className="animate-spin" />
        ) : isPaused ? (
          <BotOff size={14} />
        ) : (
          <Bot size={14} className="animate-pulse" />
        )}
        {!isToggling && (
          <div className={`absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-emerald-500 shadow-glow-green'}`} />
        )}
      </div>
      
      <span className="min-w-[80px] text-left">
        {isPaused ? 'Paused' : 'Auto-responding'}
      </span>

      <div className="ml-1 opacity-50">
        {isPaused ? <Play size={10} fill="currentColor" /> : <Pause size={10} fill="currentColor" />}
      </div>
    </button>
  );
}
