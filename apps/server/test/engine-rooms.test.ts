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

describe('私有房 agent ACL', () => {
  it('owner 与成员 key 的 agent 可加入，无关 key 的 agent 拒绝', () => {
    const w = makeWorld();
    w.storage.createKey({ id: 'key_own', hash: 'ho', label: null, createdAt: 't' });
    w.storage.createKey({ id: 'key_mem', hash: 'hm', label: null, createdAt: 't' });
    w.storage.createKey({ id: 'key_out', hash: 'hx', label: null, createdAt: 't' });
    w.storage.createRoom({
      id: 'rm_priv', title: '私', topic: null, visibility: 'private', ownerKeyId: 'key_own',
      inviteCode: 'c', cooldownMs: 10000, maxAgents: 20, at: 't',
    });
    const ownerAgent = w.storage.upsertAgent({ keyId: 'key_own', name: '主豆', at: 't' });
    w.storage.setAgentStatus(ownerAgent.id, 'online', 't');
    expect(w.engine.joinRoom(ownerAgent.id, 'rm_priv').status).toBe('active');

    w.storage.addMember('rm_priv', 'key_mem', 'member', 't');
    const memAgent = w.storage.upsertAgent({ keyId: 'key_mem', name: '客豆', at: 't' });
    w.storage.setAgentStatus(memAgent.id, 'online', 't');
    expect(w.engine.joinRoom(memAgent.id, 'rm_priv').status).toBe('active');

    const outAgent = w.storage.upsertAgent({ keyId: 'key_out', name: '野豆', at: 't' });
    w.storage.setAgentStatus(outAgent.id, 'online', 't');
    try {
      w.engine.joinRoom(outAgent.id, 'rm_priv');
      expect.unreachable();
    } catch (e) {
      expect((e as EngineError).code).toBe('forbidden');
    }
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

describe('kick/leave 的在途事件与 updateRoomSettings', () => {
  it('踢人时在途事件记 rejected(kicked)，stats 平衡，presence 不再包含被踢 agent', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    w.engine.kickAgent('lobby', a.id);
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('rejected');
    expect(w.storage.getEvent(dispatched[0].eventId)?.reason).toBe('kicked');
    const st = w.storage.getStats(a.id);
    expect(st.delivered).toBe(1);
    expect(st.rejected).toBe(1);
    expect(w.engine.listPresence('lobby')).toHaveLength(0);
  });

  it('主动离开时在途事件记 skipped(agent_left)', () => {
    const w = makeWorld();
    const dispatched = record(w.bus, Topics.eventDispatch);
    const a = addAgent(w, '小豆');
    join(w, a.id);
    w.engine.humanPost('lobby', 'key_1', '阿伟', 'hi');
    w.engine.leaveRoom(a.id, 'lobby');
    expect(w.storage.getEvent(dispatched[0].eventId)?.status).toBe('skipped');
    expect(w.storage.getEvent(dispatched[0].eventId)?.reason).toBe('agent_left');
  });

  it('updateRoomSettings 提高上限触发候补转正；归档房间拒绝改设置', () => {
    const w = makeWorld();
    w.storage.updateRoom('lobby', { maxAgents: 1 });
    const a1 = addAgent(w, '甲');
    const a2 = addAgent(w, '乙');
    join(w, a1.id);
    join(w, a2.id); // waiting
    w.engine.updateRoomSettings('lobby', { maxAgents: 2 });
    expect(w.storage.getRoomAgent('lobby', a2.id)?.status).toBe('active');
    w.storage.updateRoom('lobby', { status: 'archived' });
    expect(() => w.engine.updateRoomSettings('lobby', { title: 'x' })).toThrowError(EngineError);
  });
});
