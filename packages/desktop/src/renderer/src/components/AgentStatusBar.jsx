import { useAgent } from '../context/AgentContext';

export default function AgentStatusBar() {
  const agent = useAgent();

  if (!agent) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-800/50">
      <div className={`w-2 h-2 rounded-full ${
        agent.connected ? 'bg-green-400' : 'bg-red-400'
      }`} />
      <span className="text-xs text-surface-400">
        {agent.connected ? 'Connected' : 'Disconnected'}
      </span>
      {agent.connected && (
        <span className={`text-xs ${agent.fbSessionValid ? 'text-green-400' : 'text-amber-400'}`}>
          {agent.fbSessionValid ? 'FB Active' : 'FB Not Connected'}
        </span>
      )}
    </div>
  );
}
