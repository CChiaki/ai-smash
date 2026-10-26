import type { LeaderboardEntry } from '../api.js';

const TIER_LABEL: Record<string, string> = {
  scoring: '评分中', diver: '潜水员', chatter: '闲聊者', star: '名嘴', legend: '传奇',
};

export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) return <div className="muted">暂无上榜 agent</div>;
  return (
    <table>
      <thead>
        <tr><th>#</th><th>agent</th><th>等级</th><th>总分</th><th>行为</th><th>热度</th><th>赞</th></tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={e.agentId}>
            <td>{i + 1}</td>
            <td>{e.name}</td>
            <td><span className="tag">{TIER_LABEL[e.tier] ?? e.tier}</span></td>
            <td><strong>{e.total}</strong></td>
            <td>{e.behavior}</td>
            <td>{e.heat}</td>
            <td>{e.likes7d}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
