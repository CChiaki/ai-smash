import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

// 文件库用后即删（each：仅本文件用到 dir 变量，简单兜底清理）
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fileStorage(): { s: SqliteStorage; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-smash-rooms-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  return { s: new SqliteStorage(path), path };
}

function setup() {
  const s = new SqliteStorage(':memory:');
  s.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: 't' });
  return s;
}

describe('rooms', () => {
  it('ensureLobby 幂等', () => {
    const s = setup();
    const r1 = s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    const r2 = s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't2' });
    expect(r1.id).toBe('lobby');
    expect(r2.id).toBe('lobby');
    expect(r1.visibility).toBe('public');
    // 全新 DB 首启即 2.3 的 2s 冷却（与 SCHEMA 默认/迁移一致）
    expect(r1.cooldownMs).toBe(2000);
  });

  it('lobby 冷却迁移恰好一次（user_version 门闩）：旧库生效且管理员改回不被覆盖（M7）', () => {
    const { s: s1, path } = fileStorage();
    s1.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    s1.updateRoom('lobby', { cooldownMs: 10000 });
    s1.close();
    // 模拟 2.3 之前的旧库：迁移门闩（user_version）尚未写入
    const raw = new Database(path);
    raw.pragma('user_version = 0');
    raw.close();
    const s2 = new SqliteStorage(path);
    expect(s2.getRoom('lobby')?.cooldownMs).toBe(2000); // 旧库首启：迁移生效
    s2.close();
    const s3 = new SqliteStorage(path);
    s3.updateRoom('lobby', { cooldownMs: 10000 }); // 管理员刻意改回
    s3.close();
    const s4 = new SqliteStorage(path);
    expect(s4.getRoom('lobby')?.cooldownMs).toBe(10000); // 重启不再覆盖
    s4.close();
  });
  it('创建私有房间并按邀请码查询', () => {
    const s = setup();
    const room = s.createRoom({
      id: 'rm_1', title: '深夜哲学', topic: '意识是什么', visibility: 'private',
      ownerKeyId: 'key_1', inviteCode: 'abc123', cooldownMs: 10000, maxAgents: 20, at: 't1',
    });
    expect(room.status).toBe('active');
    expect(s.getRoomByInviteCode('abc123')?.id).toBe('rm_1');
    expect(s.getRoomByInviteCode('nope')).toBeUndefined();
  });
  it('listRooms 按 visibility 过滤', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    s.createRoom({
      id: 'rm_1', title: '私房', topic: null, visibility: 'private',
      ownerKeyId: 'key_1', inviteCode: 'c1', cooldownMs: 10000, maxAgents: 20, at: 't1',
    });
    expect(s.listRooms()).toHaveLength(2);
    expect(s.listRooms('public')).toHaveLength(1);
    expect(s.listRooms('private')).toHaveLength(1);
  });
  it('updateRoom 局部更新', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    const r = s.updateRoom('lobby', { status: 'paused', cooldownMs: 5000 });
    expect(r.status).toBe('paused');
    expect(r.cooldownMs).toBe(5000);
    expect(r.title).toBe('大厅');
  });
});

describe('room_agents', () => {
  it('加入/状态/候补列表/计数', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 1, at: 't1' });
    s.upsertAgent({ id: 'ag_1', keyId: 'key_1', name: '小豆', at: 't1' });
    s.upsertAgent({ id: 'ag_2', keyId: 'key_1', name: '老豆', at: 't1' });
    s.upsertAgent({ id: 'ag_3', keyId: 'key_1', name: '三豆', at: 't1' });
    s.addRoomAgent('lobby', 'ag_1', 'active', 't1');
    s.addRoomAgent('lobby', 'ag_2', 'waiting', 't2');
    s.addRoomAgent('lobby', 'ag_3', 'waiting', 't3');
    expect(s.countRoomAgents('lobby', 'active')).toBe(1);
    expect(s.listWaitingAgents('lobby').map((r) => r.agentId)).toEqual(['ag_2', 'ag_3']);
    s.setRoomAgentStatus('lobby', 'ag_2', 'active');
    expect(s.countRoomAgents('lobby', 'active')).toBe(2);
    expect(s.listRoomsOfAgent('ag_2')).toHaveLength(1);
    s.removeRoomAgent('lobby', 'ag_2');
    expect(s.getRoomAgent('lobby', 'ag_2')).toBeUndefined();
  });
  it('countKeyAgentsInRoom 只统计 active/waiting', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    for (const [id, name] of [['ag_1', 'a'], ['ag_2', 'b'], ['ag_3', 'c']] as const) {
      s.upsertAgent({ id, keyId: 'key_1', name, at: 't1' });
      s.addRoomAgent('lobby', id, 'active', 't1');
    }
    s.setRoomAgentStatus('lobby', 'ag_3', 'kicked');
    expect(s.countKeyAgentsInRoom('lobby', 'key_1')).toBe(2);
  });
});

describe('room_members', () => {
  it('成员增查删', () => {
    const s = setup();
    s.ensureLobby({ title: '大厅', maxAgents: 50, at: 't1' });
    s.addMember('lobby', 'key_1', 'host', 't1');
    expect(s.getMember('lobby', 'key_1')?.role).toBe('host');
    s.removeMember('lobby', 'key_1');
    expect(s.getMember('lobby', 'key_1')).toBeUndefined();
  });
});
