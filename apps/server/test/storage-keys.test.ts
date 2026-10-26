import { describe, expect, it } from 'vitest';
import { newId, newInviteCode, newKey, sha256 } from '../src/ids.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('ids', () => {
  it('生成带前缀的 id', () => {
    expect(newId('m').startsWith('m_')).toBe(true);
    expect(newKey().startsWith('sk_')).toBe(true);
    expect(newInviteCode().length).toBeGreaterThan(4);
  });
  it('sha256 稳定', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
  });
});

describe('keys storage', () => {
  it('创建并按 hash 查询', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: '阿伟的钥匙', createdAt: '2026-10-26T00:00:00.000Z' });
    const key = s.getKeyByHash('h1');
    expect(key?.id).toBe('key_1');
    expect(key?.status).toBe('active');
    expect(key?.label).toBe('阿伟的钥匙');
    expect(s.getKeyByHash('nope')).toBeUndefined();
  });
  it('封禁与解封', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: '2026-10-26T00:00:00.000Z' });
    s.setKeyStatus('key_1', 'banned');
    expect(s.getKey('key_1')?.status).toBe('banned');
    s.setKeyStatus('key_1', 'active');
    expect(s.getKey('key_1')?.status).toBe('active');
  });
  it('同一 hash 不可重复', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    expect(() => s.createKey({ id: 'key_2', hash: 'h1', label: null, createdAt: 'x' })).toThrow();
  });
});

describe('agents storage', () => {
  it('同名复用同一 agent（身份恢复）', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    const a1 = s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    const a2 = s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't2' });
    expect(a2.id).toBe(a1.id);
  });
  it('显式 agentId 与 key 不匹配时报错', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    s.createKey({ id: 'key_2', hash: 'h2', label: null, createdAt: 'x' });
    s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    expect(() =>
      s.upsertAgent({ id: 'ag_x', keyId: 'key_2', name: '小豆', at: 't1' }),
    ).not.toThrow();
    s.upsertAgent({ id: 'ag_fix', keyId: 'key_1', name: '老豆', at: 't1' });
    expect(() =>
      s.upsertAgent({ id: 'ag_fix', keyId: 'key_2', name: '抢名字', at: 't2' }),
    ).toThrow();
  });
  it('按 key 列出 agents', () => {
    const s = new SqliteStorage(':memory:');
    s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 'x' });
    s.upsertAgent({ keyId: 'key_1', name: '小豆', at: 't1' });
    s.upsertAgent({ keyId: 'key_1', name: '老豆', at: 't1' });
    expect(s.listAgentsByKey('key_1')).toHaveLength(2);
    expect(s.listAgents()).toHaveLength(2);
  });
});
