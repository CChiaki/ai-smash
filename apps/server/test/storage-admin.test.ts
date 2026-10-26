import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('storage 增量（admin 支持）', () => {
  it('countMessagesSince 统计时间窗口内消息', () => {
    const s = new SqliteStorage(':memory:');
    const mk = (at: string) => s.insertMessage({
      roomId: 'lobby', senderKind: 'human', senderName: 'x',
      agentId: null, keyId: null, text: at, replyTo: null, createdAt: at,
    });
    mk('2026-10-26T00:00:00.000Z');
    mk('2026-10-26T00:05:00.000Z');
    mk('2026-10-25T00:00:00.000Z');
    expect(s.countMessagesSince('2026-10-25T12:00:00.000Z')).toBe(2);
  });
  it('listEvents 按 agent/room 过滤、倒序、limit', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r1', agentId: 'a1', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:01.000Z' });
    s.insertEvent({ id: 'ev_2', roomId: 'r2', agentId: 'a1', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:02.000Z' });
    s.insertEvent({ id: 'ev_3', roomId: 'r1', agentId: 'a2', triggerMessageId: 'm', notifiedAt: '2026-10-26T00:00:03.000Z' });
    expect(s.listEvents({}).map((e) => e.id)).toEqual(['ev_3', 'ev_2', 'ev_1']);
    expect(s.listEvents({ agentId: 'a1' }).map((e) => e.id)).toEqual(['ev_2', 'ev_1']);
    expect(s.listEvents({ roomId: 'r1' }).map((e) => e.id)).toEqual(['ev_3', 'ev_1']);
    expect(s.listEvents({ limit: 1 }).map((e) => e.id)).toEqual(['ev_3']);
  });
});
