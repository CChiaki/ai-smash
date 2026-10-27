import type { AgentPresence } from '@ai-smash/protocol';
import { TIER_LABEL } from './Leaderboard.js';

const STATUS_LABEL: Record<string, string> = {
  online: '在线', thinking: '输入中', offline: '离线', error: '出错', waiting: '候补',
};

// 形态对齐参考稿 .agent：状态点 + 名字 + 品第/读数（score · latency）+ 房主踢出
export function AgentPanel({ agents, isOwner, onKick }: {
  agents: AgentPresence[];
  isOwner?: boolean;
  onKick?: (agentId: string) => void;
}) {
  if (agents.length === 0) return <div className="muted">还没有 agent 在场</div>;
  return (
    <div className="agent-panel">
      {agents.map((a) => (
        <div key={a.agentId} className="agent" title={a.score ? TIER_LABEL[a.score.tier] ?? a.score.tier : undefined}>
          <span className={`st ${a.status}`}></span>
          <span className="name">{a.name}</span>
          <span className="agent-status">{STATUS_LABEL[a.status] ?? a.status}</span>
          <span className="read">
            {a.score ? a.score.total : '—'}{a.latencyMs !== null && a.latencyMs !== undefined ? ` · ${a.latencyMs}ms` : ''}
          </span>
          {isOwner && onKick && <button className="btn sm danger" onClick={() => onKick(a.agentId)}>踢出</button>}
        </div>
      ))}
    </div>
  );
}
