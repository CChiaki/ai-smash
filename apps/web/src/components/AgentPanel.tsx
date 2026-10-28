import { useState } from 'react';
import type { AgentPresence, TraceKind } from '@ai-smash/protocol';
import { TIER_LABEL } from './Leaderboard.js';

const STATUS_LABEL: Record<string, string> = {
  online: '在线', thinking: '输入中', offline: '离线', error: '出错', waiting: '候补',
};

// 形态对齐参考稿 .agent：状态点 + 名字 + 品第/读数（score · latency）+ 被点名徽章 + 房主踢出
// 点击行展开该 Agent 的 trace 面板（2.2）：traces 由 RoomState 持有，回放模式不传（暂无上报空态）
export function AgentPanel({ agents, traces, isOwner, onKick }: {
  agents: AgentPresence[];
  traces?: Record<string, Array<{ kind: TraceKind; text: string }>>;
  isOwner?: boolean;
  onKick?: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (agents.length === 0) return <div className="muted">还没有 agent 在场</div>;
  return (
    <div className="agent-panel">
      {agents.map((a) => (
        <div
          key={a.agentId}
          className="agent"
          title={a.score ? TIER_LABEL[a.score.tier] ?? a.score.tier : undefined}
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(expanded === a.agentId ? null : a.agentId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded(expanded === a.agentId ? null : a.agentId);
            }
          }}
        >
          <span className={`st ${a.status}`}></span>
          <span className="name">{a.name}</span>
          {a.mentioned ? <span className="tag">被点名</span> : null}
          <span className="agent-status">{STATUS_LABEL[a.status] ?? a.status}</span>
          <span className="read">
            {a.score ? a.score.total : '—'}{a.latencyMs !== null && a.latencyMs !== undefined ? ` · ${a.latencyMs}ms` : ''}
          </span>
          {isOwner && onKick && (
            <button
              className="btn sm danger"
              onClick={(e) => {
                e.stopPropagation();
                onKick(a.agentId);
              }}
            >
              踢出
            </button>
          )}
          {expanded === a.agentId && (
            <div className="agent-traces" onClick={(e) => e.stopPropagation()}>
              {(traces?.[a.agentId]?.length ?? 0) === 0
                ? <div className="muted">暂无上报</div>
                : traces![a.agentId].map((t, i) => (
                  <div className="trace-row" key={i}>
                    <span className={`trace-kind trace-${t.kind}`}>{t.kind === 'thought' ? '思考' : '工具'}</span>
                    <span>{t.text}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
