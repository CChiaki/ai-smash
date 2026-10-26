import type { Limits } from '@ai-smash/protocol';
import type { Storage } from '../storage/types.js';

export interface AgentMetrics {
  delivered: number; posted: number; skipped: number; timeout: number;
  rejected: number; throttled: number; medianLatencyMs: number | null;
  repliesReceived: number; likes7d: number; events: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function collectAgentMetrics(storage: Storage, agentId: string, sinceIso: string): AgentMetrics {
  const m = storage.eventMetrics(agentId, sinceIso);
  return {
    delivered: m.delivered,
    posted: m.posted,
    skipped: m.skipped,
    timeout: m.timeout,
    rejected: m.rejected,
    throttled: m.throttled,
    medianLatencyMs: median(m.latencies),
    repliesReceived: storage.countRepliesTo(agentId, sinceIso),
    likes7d: storage.countLikesByAgent(agentId, sinceIso),
    events: m.delivered,
  };
}

export function computeBehavior(m: AgentMetrics): {
  behavior: number;
  parts: { response: number; engaged: number; latency: number; compliance: number };
} {
  const response = m.delivered === 0 ? 0 : 1 - (m.timeout + m.rejected) / m.delivered;
  const engaged = m.posted === 0 ? 0 : Math.min(1, m.repliesReceived / m.posted);
  // 规格未定义"无发言"时的延迟分，取 0：不发言的 agent 不因沉默得分
  const latency = m.medianLatencyMs === null
    ? 0
    : m.medianLatencyMs <= 5000
      ? 1
      : m.medianLatencyMs >= 20000
        ? 0
        : (20_000 - m.medianLatencyMs) / 15_000;
  const denom = m.posted + m.skipped;
  // 「零参与」(posted=0 且 skipped=0) 不应因从未被限流而得满合规分，取 0
  const compliance = denom === 0 ? 0 : Math.max(0, 1 - m.throttled / denom);
  const behavior = Math.round(100 * (0.3 * response + 0.3 * engaged + 0.2 * latency + 0.2 * compliance));
  return { behavior, parts: { response, engaged, latency, compliance } };
}

export function computeHeat(likes7d: number): number {
  return Math.min(100, Math.round(25 * Math.log2(1 + likes7d)));
}

export function computeTotal(behavior: number, heat: number): number {
  return Math.round(0.7 * behavior + 0.3 * heat);
}

export type Tier = 'scoring' | 'diver' | 'chatter' | 'star' | 'legend';

export function tierOf(total: number, events: number, minEvents: number): Tier {
  if (events < minEvents) return 'scoring';
  if (total < 40) return 'diver';
  if (total < 60) return 'chatter';
  if (total < 80) return 'star';
  return 'legend';
}

export function runScoring(storage: Storage, now: Date, limits: Limits): number {
  const sinceIso = new Date(now.getTime() - limits.scoreWindowMs).toISOString();
  let count = 0;
  for (const agent of storage.listAgents()) {
    const m = collectAgentMetrics(storage, agent.id, sinceIso);
    if (m.events === 0 && m.likes7d === 0) continue;
    const { behavior } = computeBehavior(m);
    const heat = computeHeat(m.likes7d);
    const total = computeTotal(behavior, heat);
    storage.upsertScore({
      agentId: agent.id, behavior, heat, total,
      tier: tierOf(total, m.events, limits.scoreMinEvents),
      likes7d: m.likes7d, computedAt: now.toISOString(),
    });
    count += 1;
  }
  return count;
}
