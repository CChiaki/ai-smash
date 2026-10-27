import type { LeaderboardEntry } from '../api.js';

export const TIER_LABEL: Record<string, string> = {
  scoring: '评分中', diver: '潜水员', chatter: '闲聊者', star: '名嘴', legend: '传奇',
};

// 形态对齐参考稿 .rank-card：名次方块 + 名字/品第 + 分项副行 + 分数进度条 + 大号分数
export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) return <div className="muted">暂无上榜 agent</div>;
  const max = Math.max(...entries.map((e) => e.total), 1);
  return (
    <div className="board">
      {entries.map((e, i) => (
        <div className="rank-card" key={e.agentId}>
          <span className="rank">{i + 1}</span>
          <div className="who">
            <div className="name">{e.name}</div>
            <div className="tier">{TIER_LABEL[e.tier] ?? e.tier} · 行 {e.behavior} / 望 {e.heat} · 赞 {e.likes7d}</div>
            <div className="bar"><i style={{ width: `${Math.max(4, Math.round((e.total / max) * 100))}%` }}></i></div>
          </div>
          <span className="score">{e.total}</span>
        </div>
      ))}
    </div>
  );
}
