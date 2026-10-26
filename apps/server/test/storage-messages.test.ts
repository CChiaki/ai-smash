import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

function msg(s: SqliteStorage, roomId: string, text: string, extra: Partial<Parameters<SqliteStorage['insertMessage']>[0]> = {}) {
  return s.insertMessage({
    roomId, senderKind: 'human', senderName: '阿伟',
    agentId: null, keyId: 'key_1', text, replyTo: null, createdAt: '2026-10-26T00:00:00.000Z',
    ...extra,
  });
}

describe('messages', () => {
  it('seq 在房间内自增', () => {
    const s = new SqliteStorage(':memory:');
    const m1 = msg(s, 'lobby', '一');
    const m2 = msg(s, 'lobby', '二');
    const other = msg(s, 'rm_9', '别的房间');
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(other.seq).toBe(1);
  });
  it('listMessages 按 seq 升序、支持 afterSeq 与 limit', () => {
    const s = new SqliteStorage(':memory:');
    for (const t of ['一', '二', '三', '四']) msg(s, 'lobby', t);
    expect(s.listMessages('lobby').map((m) => m.text)).toEqual(['一', '二', '三', '四']);
    expect(s.listMessages('lobby', { afterSeq: 2 }).map((m) => m.text)).toEqual(['三', '四']);
    expect(s.listMessages('lobby', { limit: 2 }).map((m) => m.text)).toEqual(['三', '四']);
  });
  it('软删除', () => {
    const s = new SqliteStorage(':memory:');
    const m = msg(s, 'lobby', '违规内容');
    s.softDeleteMessage(m.id, 't');
    expect(s.getMessage(m.id)?.deletedAt).toBe('t');
  });
  it('countRepliesTo 统计别人回复我的消息数', () => {
    const s = new SqliteStorage(':memory:');
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    const mine = msg(s, 'lobby', '我说', { senderKind: 'agent', senderName: '小豆', agentId: 'ag_1' });
    msg(s, 'lobby', '回复1', { replyTo: mine.id });
    msg(s, 'lobby', '回复2', { replyTo: mine.id });
    const other = msg(s, 'lobby', '别人的', { senderKind: 'system', senderName: 'sys' });
    msg(s, 'lobby', '回复3', { replyTo: other.id });
    expect(s.countRepliesTo('ag_1', '2020-01-01T00:00:00.000Z')).toBe(2);
  });
});

describe('events', () => {
  it('插入 delivered 并 decide', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'lobby', agentId: 'ag_1', triggerMessageId: 'm_1', notifiedAt: 't1' });
    expect(s.getEvent('ev_1')?.status).toBe('delivered');
    s.decideEvent('ev_1', 'posted', null, 't2', 1200);
    const ev = s.getEvent('ev_1')!;
    expect(ev.status).toBe('posted');
    expect(ev.latencyMs).toBe(1200);
  });
  it('markAllDeliveredAsTimeout 只影响未决', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' });
    s.insertEvent({ id: 'ev_2', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' });
    s.decideEvent('ev_2', 'skipped', null, 't', null);
    expect(s.markAllDeliveredAsTimeout('boot')).toBe(1);
    expect(s.getEvent('ev_1')?.status).toBe('timeout');
    expect(s.getEvent('ev_1')?.reason).toBe('server_restart');
    expect(s.getEvent('ev_2')?.status).toBe('skipped');
  });
  it('eventMetrics 分组统计与延迟样本', () => {
    const s = new SqliteStorage(':memory:');
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't' });
    const row = { roomId: 'r', agentId: 'ag_1', triggerMessageId: 'm', notifiedAt: '2026-10-20T00:00:00.000Z' };
    s.insertEvent({ id: 'ev_1', ...row });
    s.insertEvent({ id: 'ev_2', ...row });
    s.insertEvent({ id: 'ev_3', ...row });
    s.insertEvent({ id: 'ev_4', ...row });
    s.decideEvent('ev_1', 'posted', null, 't', 3000);
    s.decideEvent('ev_2', 'posted', null, 't', 9000);
    s.decideEvent('ev_3', 'timeout', null, 't', null);
    s.decideEvent('ev_4', 'rejected', 'throttled', 't', null);
    const m = s.eventMetrics('ag_1', '2026-10-01T00:00:00.000Z');
    expect(m.delivered).toBe(4);
    expect(m.posted).toBe(2);
    expect(m.timeout).toBe(1);
    expect(m.rejected).toBe(1);
    expect(m.throttled).toBe(1);
    expect(m.latencies).toEqual([3000, 9000]);
  });
  it('lastPostedLatency 取最近一次', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't1' });
    s.insertEvent({ id: 'ev_2', roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't2' });
    s.decideEvent('ev_1', 'posted', null, 't', 1000);
    s.decideEvent('ev_2', 'posted', null, 't', 2000);
    expect(s.lastPostedLatency('a')).toBe(2000);
  });
});