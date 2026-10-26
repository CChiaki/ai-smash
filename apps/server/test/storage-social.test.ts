import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

function setup() {
  const s = new SqliteStorage(':memory:');
  s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
  s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 't' });
  s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
  const m = s.insertMessage({
    roomId: 'lobby', senderKind: 'agent', senderName: '小豆',
    agentId: 'ag_1', keyId: 'key_1', text: '说点什么', replyTo: null,
    createdAt: '2026-10-26T00:00:00.000Z',
  });
  return { s, m };
}

describe('reactions', () => {
  it('同一 key 重复点赞返回 false', () => {
    const { s, m } = setup();
    expect(s.addReaction(m.id, 'key_2', 't1')).toBe(true);
    expect(s.addReaction(m.id, 'key_2', 't2')).toBe(false);
    expect(s.countLikes(m.id)).toBe(1);
  });
  it('countLikesByAgent 通过消息归属 agent', () => {
    const { s, m } = setup();
    s.addReaction(m.id, 'key_2', '2026-10-26T00:00:00.000Z');
    expect(s.countLikesByAgent('ag_1', '2026-10-01T00:00:00.000Z')).toBe(1);
    expect(s.countLikesByAgent('ag_1', '2027-01-01T00:00:00.000Z')).toBe(0);
  });
  it('countLikesByKeySince 限频查询', () => {
    const { s, m } = setup();
    s.addReaction(m.id, 'key_2', '2026-10-26T01:00:00.000Z');
    expect(s.countLikesByKeySince('key_2', '2026-10-26T00:30:00.000Z')).toBe(1);
    expect(s.countLikesByKeySince('key_2', '2026-10-26T02:00:00.000Z')).toBe(0);
  });
});

describe('stats & scores', () => {
  it('bumpStats 累加、getStats 缺省为 0', () => {
    const { s } = setup();
    expect(s.getStats('ag_1').delivered).toBe(0);
    s.bumpStats('ag_1', { delivered: 1 });
    s.bumpStats('ag_1', { delivered: 1, posted: 1 });
    const st = s.getStats('ag_1');
    expect(st.delivered).toBe(2);
    expect(st.posted).toBe(1);
    expect(st.repliesReceived).toBe(0);
  });
  it('upsertScore 覆盖旧值，topScores 按 total 降序', () => {
    const { s } = setup();
    s.upsertScore({ agentId: 'ag_1', behavior: 60, heat: 50, total: 57, tier: 'chatter', likes7d: 4, computedAt: 't' });
    s.upsertScore({ agentId: 'ag_1', behavior: 80, heat: 0, total: 56, tier: 'star', likes7d: 0, computedAt: 't2' });
    expect(s.getScore('ag_1')?.total).toBe(56);
    s.upsertScore({ agentId: 'ag_2', behavior: 90, heat: 100, total: 93, tier: 'legend', likes7d: 100, computedAt: 't' });
    expect(s.topScores(2).map((r) => r.agentId)).toEqual(['ag_2', 'ag_1']);
  });
});

describe('audit', () => {
  it('写入并按时间倒序读取', () => {
    const s = new SqliteStorage(':memory:');
    s.insertAudit({ action: 'ban_key', targetType: 'key', targetId: 'key_1', detail: '{}', createdAt: 't1' });
    s.insertAudit({ action: 'kick_agent', targetType: 'agent', targetId: 'ag_1', detail: '{}', createdAt: 't2' });
    const rows = s.listAudit(10);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe('kick_agent');
  });
});