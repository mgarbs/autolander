import React, { createContext, useContext, useState, useEffect } from 'react';

const AgentContext = createContext(null);

export function AgentProvider({ children }) {
  const [agentStatus, setAgentStatus] = useState({
    connected: false,
    fbSessionValid: false,
  });

  useEffect(() => {
    if (!window.autolander?.agent) return;

    // Listen for status updates from main process
    const unsub = window.autolander.agent.onStatusUpdate((status) => {
      setAgentStatus(prev => ({ ...prev, ...status }));
    });

    // Get initial status
    window.autolander.agent.getStatus().then(status => {
      setAgentStatus(status);
    }).catch(() => {});

    return unsub;
  }, []);

  return (
    <AgentContext.Provider value={agentStatus}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  return useContext(AgentContext);
}

export default AgentContext;
