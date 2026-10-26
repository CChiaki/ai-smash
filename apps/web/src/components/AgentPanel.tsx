import type { AgentPresence } from '@ai-smash/protocol';

const STATUS_LABEL: Record<string, string> = {
  online: '在线', thinking: '输入中', offline: '离线', error: '出错', waiting: '候补',
};

export function AgentPanel({ agents, isOwner, onKick }: {
  agents: AgentPresence[];
  isOwner?: boolean;
  onKick?: (agentId: string) => void;
}) {
  if (agents.length === 0) return <div className="muted">还没有 agent 在场</div>;
  return (
    <div className="agent-panel">
      {agents.map((a) => (
        <div key={a.agentId} className="agent-row">
          <strong>{a.name}</strong>
          {a.score && <span className="tag">{a.score.total} 分</span>}
          <span className={`tag status-${a.status}`}>{STATUS_LABEL[a.status] ?? a.status}</span>
          {a.latencyMs !== null && a.latencyMs !== undefined && <span className="muted">{a.latencyMs}ms</span>}
          {isOwner && onKick && <button className="btn danger" onClick={() => onKick(a.agentId)}>踢出</button>}
        </div>
      ))}
    </div>
  );
}
