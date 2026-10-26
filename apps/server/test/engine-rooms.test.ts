import { Topics } from '../src/topics.js';
import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/engine/errors.js';
import { addAgent, join, makeWorld, record } from './helpers.js';

describe('joinRoom', () => {
  it('未满时直接成为正式成员', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    expect(join(w, a.id).status).toBe('active');
    expect(w.storage.countRoomAgents('lobby', 'active')).toBe(1);
  });

  it('满员时进入候补，退出后按顺序转正', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    const a1 = addAgent(w, '甲');
    const a2 = addAgent(w, '乙');
    expect(join(w, a1.id).status).toBe('active');
    expect(join(w, a2.id).status).toBe('waiting');
    w.engine.leaveRoom(a1.id, 'lobby');
    expect(w.storage.getRoomAgent('lobby', a2.id)?.status).toBe('active');
  });

  it('被踢后禁止再次加入', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.kickAgent('lobby', a.id);
    expect(() => join(w, a.id)).toThrowError(EngineError);
    try {
      join(w, a.id);
    } catch (e) {
      expect((e as EngineError).code).toBe('kicked');
    }
  });

  it('同 key 同房间超过 3 个 agent 拒绝（forbidden）', () => {
    const w = makeWorld();
    const agents = ['a', 'b', 'c', 'd'].map((n) => addAgent(w, n));
    for (const a of agents.slice(0, 3)) join(w, a.id);
    expect(() => join(w, agents[3].id)).toThrowError(EngineError);
  });

  it('归档房间拒绝加入', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { status: 'archived' });
    const a = addAgent(w, '小豆');
    try {
      join(w, a.id);
      expect.unreachable();
    } catch (e) {
      expect((e as EngineError).code).toBe('archived');
    }
  });

  it('不存在的房间 not_found', () => {
    const w = makeWorld();
    const a = addAgent(w, '小豆');
    expect(() => w.engine.joinRoom(a.id, 'rm_no')).toThrowError(EngineError);
  });
});

describe('pause / resume', () => {
  it('暂停与恢复发出 roomUpdate', () => {
    const w = makeWorld();
    const updates = record(w.bus, Topics.roomUpdate);
    w.engine.pauseRoom('lobby');
    w.engine.resumeRoom('lobby');
    expect(updates.map((u) => u.room.status)).toEqual(['paused', 'active']);
    expect(w.storage.getRoom('lobby')?.status).toBe('active');
  });
});

describe('listPresence', () => {
  it('候补与在线状态正确，分数缺省为 null', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    const a1 = addAgent(w, '甲');
    const a2 = addAgent(w, '乙');
    join(w, a1.id);
    join(w, a2.id);
    const presence = w.engine.listPresence('lobby');
    expect(presence.find((p) => p.agentId === a1.id)?.status).toBe('online');
    expect(presence.find((p) => p.agentId === a2.id)?.status).toBe('waiting');
    expect(presence[0].score).toBeNull();
  });
});
