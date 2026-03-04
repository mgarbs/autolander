import { useAgent as useAgentContext } from '../context/AgentContext';

export function useAgent() {
  return useAgentContext();
}
