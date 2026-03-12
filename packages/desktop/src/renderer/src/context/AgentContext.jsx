import React, { createContext, useContext, useState, useEffect } from 'react';

const AgentContext = createContext(null);

export function AgentProvider({ children }) {
  const [agentStatus, setAgentStatus] = useState({
    connected: false,
    fbSessionValid: false,
    lastHeartbeat: null,
    activeCommand: null,
  });

  const refreshStatus = async () => {
    if (!window.autolander?.agent) return;
    try {
      const status = await window.autolander.agent.getStatus();
      setAgentStatus(prev => ({ ...prev, ...status }));
    } catch (err) {
      console.error('Failed to refresh agent status:', err);
    }
  };

  useEffect(() => {
    if (!window.autolander?.agent) return;

    // Listen for status updates from main process
    const unsub = window.autolander.agent.onStatusUpdate((status) => {
      setAgentStatus(prev => ({ ...prev, ...status }));
    });

    // Get initial status
    refreshStatus();

    return unsub;
  }, []);

  return (
    <AgentContext.Provider value={{ ...agentStatus, refreshStatus }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  return useContext(AgentContext);
}

export default AgentContext;
