import React, { createContext, useContext, useEffect, useState } from 'react';
import { wsClient } from '../api/ws-client';
import { getBaseUrl } from '../api/client';
import { useAuth } from './AuthContext';

const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [lastEvents, setLastEvents] = useState({
    lead: null,
    inventory: null,
    appointment: null,
    agent: null,
  });
  const [notification, setNotification] = useState(null);

  const showNotification = (message, type = 'info') => {
    const id = Date.now();
    setNotification({ id, message, type });
    setTimeout(() => {
      setNotification(prev => prev?.id === id ? null : prev);
    }, 5000);
  };

  useEffect(() => {
    if (!user) {
      wsClient.disconnect();
      setConnected(false);
      return;
    }

    const token = localStorage.getItem('accessToken');
    if (!token) return;

    wsClient.connect(getBaseUrl(), token);

    const unsubConnect = wsClient.on('connected', () => setConnected(true));
    const unsubDisconnect = wsClient.on('disconnected', () => setConnected(false));
    
    const handleEvent = (type, stateKey) => {
      return wsClient.on(type, (data) => {
        setLastEvents(prev => ({ ...prev, [stateKey]: data }));
        
        // Specific toast handling
        if (type === 'lead:new') {
          showNotification(`New lead: ${data.data?.name || 'Unknown'}`, 'success');
        } else if (type === 'appointment:created') {
          showNotification(`New appointment booked!`, 'info');
        }
      });
    };

    const unsubs = [
      unsubConnect,
      unsubDisconnect,
      handleEvent('lead:new', 'lead'),
      handleEvent('lead:updated', 'lead'),
      handleEvent('inventory:updated', 'inventory'),
      handleEvent('appointment:created', 'appointment'),
      handleEvent('appointment:cancelled', 'appointment'),
      handleEvent('agent:status', 'agent'),
    ];

    return () => {
      unsubs.forEach(unsub => unsub());
      wsClient.disconnect();
    };
  }, [user]);

  return (
    <RealtimeContext.Provider value={{ connected, lastEvents, notification, showNotification, wsClient }}>
      {children}
      {notification && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className={`px-4 py-2 rounded-lg shadow-lg border ${
            notification.type === 'success' ? 'bg-emerald-900/90 border-emerald-500 text-emerald-50' : 
            'bg-surface-800/90 border-brand-500 text-white'
          } flex items-center gap-3 backdrop-blur-md`}>
            {notification.type === 'success' && (
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-glow-green" />
            )}
            <span className="text-sm font-medium">{notification.message}</span>
            <button 
              onClick={() => setNotification(null)}
              className="ml-2 hover:opacity-70 transition-opacity"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  return useContext(RealtimeContext);
}

export default RealtimeContext;
