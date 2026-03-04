import React, { createContext, useContext, useEffect, useState } from 'react';
import { wsClient } from '../api/ws-client';
import { getBaseUrl } from '../api/client';
import { useAuth } from './AuthContext';

const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);

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
    const unsubMessage = wsClient.on('message', (msg) => setLastEvent(msg));

    return () => {
      unsubConnect();
      unsubDisconnect();
      unsubMessage();
      wsClient.disconnect();
    };
  }, [user]);

  return (
    <RealtimeContext.Provider value={{ connected, lastEvent, wsClient }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  return useContext(RealtimeContext);
}

export default RealtimeContext;
