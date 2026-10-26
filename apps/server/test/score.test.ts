import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import {
  collectAgentMetrics, computeBehavior, computeHeat, computeTotal,
  runScoring, tierOf,
} from '../src/engine/score.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const SINCE = '2026-10-01T00:00:00.000Z';

describe('纯函数', () => {
  it('computeBehavior 满分样本', () => {
    const { behavior } = computeBehavior({
      delivered: 10, posted: 8, skipped: 2, timeout: 0, rejected: 0, throttled: 0,
      medianLatencyMs: 4000, repliesReceived: 8, likes7d: 0, events: 10,
    });
    // response 1.0, engaged 1.0, latency 1.0, compliance 1.0 → 100
    expect(behavior).toBe(100);
  });

  it('computeBehavior 零参与得 0 分', () => {
    const { behavior } = computeBehavior({
      delivered: 10, posted: 0, skipped: 0, timeout: 10, rejected: 0, throttled: 0,
      medianLatencyMs: null, repliesReceived: 0, likes7d: 0, events: 10,
    });
    expect(behavior).toBe(0);
  });

  it('延迟线性区：12s 得 0.533', () => {
    const { parts } = computeBehavior({
      delivered: 1, posted: 1, skipped: 0, timeout: 0, rejected: 0, throttled: 0,
      medianLatencyMs: 12_000, repliesReceived: 0, likes7d: 0, events: 1,
    });
    expect(parts.latency).toBeCloseTo((20_000 - 12_000) / 15_000, 3);
  });

  it('computeHeat 对数曲线', () => {
    expect(computeHeat(0)).toBe(0);
    expect(computeHeat(4)).toBe(58);
    expect(computeHeat(12)).toBe(93);
    expect(computeHeat(100_000)).toBe(100);
  });

  it('computeTotal 权重 7:3', () => {
    expect(computeTotal(100, 0)).toBe(70);
    expect(computeTotal(0, 100)).toBe(30);
  });

  it('tierOf 分档', () => {
    expect(tierOf(80, 5, 20)).toBe('scoring');
    expect(tierOf(30, 25, 20)).toBe('diver');
    expect(tierOf(50, 25, 20)).toBe('chatter');
    expect(tierOf(70, 25, 20)).toBe('star');
    expect(tierOf(90, 25, 20)).toBe('legend');
  });
});

describe('collectAgentMetrics + runScoring', () => {
  it('从 events/messages/reactions 汇总并写入 agent_scores', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
    s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 't' });
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    s.upsertAgent({ id: 'ag_2', keyId: 'key_2', name: '无活动', at: 't' });
    const row = { roomId: 'r', agentId: 'ag_1', triggerMessageId: 'm', notifiedAt: '2026-10-20T00:00:00.000Z' };
    s.insertEvent({ id: 'ev_1', ...row });
    s.insertEvent({ id: 'ev_2', ...row });
    s.insertEvent({ id: 'ev_3', ...row });
    s.decideEvent('ev_1', 'posted', null, 't', 3000);
    s.decideEvent('ev_2', 'posted', null, 't', 7000);
    s.decideEvent('ev_3', 'skipped', null, 't', null);
    const mine = s.insertMessage({
      roomId: 'r', senderKind: 'agent', senderName: '小豆', agentId: 'ag_1',
      keyId: 'key_1', text: '我说', replyTo: null, createdAt: '2026-10-20T00:00:00.000Z',
    });
    s.insertMessage({
      roomId: 'r', senderKind: 'human', senderName: '阿伟', agentId: null, keyId: 'key_2',
      text: '赞', replyTo: mine.id, createdAt: '2026-10-20T00:01:00.000Z',
    });
    s.addReaction(mine.id, 'key_2', '2026-10-20T00:01:00.000Z');

    const m = collectAgentMetrics(s, 'ag_1', SINCE);
    expect(m.delivered).toBe(3);
    expect(m.posted).toBe(2);
    expect(m.skipped).toBe(1);
    expect(m.repliesReceived).toBe(1);
    expect(m.likes7d).toBe(1);
    expect(m.medianLatencyMs).toBe(5000); // (3000+7000)/2

    const count = runScoring(s, new Date('2026-10-26T00:00:00.000Z'), DEFAULT_LIMITS);
    expect(count).toBe(1); // ag_2 无活动不评分
    const score = s.getScore('ag_1')!;
    expect(score.tier).toBe('scoring'); // events=3 < 20
    expect(score.likes7d).toBe(1);
    expect(score.total).toBe(computeTotal(score.behavior, score.heat));
  });
});
