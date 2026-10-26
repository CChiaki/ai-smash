import { DEFAULT_LIMITS, type Limits } from '@ai-smash/protocol';
import { MemoryBus } from '../src/bus.js';
import { RoomEngine } from '../src/engine/room.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

export interface World {
  storage: SqliteStorage;
  bus: MemoryBus;
  engine: RoomEngine;
  keyId: string;
  limits: Limits;
}

export function makeWorld(overrides: Partial<Limits> = {}): World {
  const storage = new SqliteStorage(':memory:');
  const bus = new MemoryBus();
  const at = new Date().toISOString();
  const key = storage.createKey({ id: 'key_1', hash: 'h1', label: null, createdAt: at });
  storage.ensureLobby({ title: '大厅', maxAgents: 50, at });
  if (overrides.cooldownMs !== undefined) {
    storage.updateRoom('lobby', { cooldownMs: overrides.cooldownMs });
  }
  const limits = {
    ...DEFAULT_LIMITS,
    // 默认把 deadline 拉到 1 小时，避免测试里未处理的派发被超时打断；
    // 超时相关测试显式传 deadlineMs 覆盖。
    deadlineMs: 3_600_000,
    ...overrides,
  } as Limits;
  const engine = new RoomEngine({ storage, bus, limits });
  return { storage, bus, engine, keyId: key.id, limits };
}

export function addAgent(
  w: World, name: string, id?: string, keyId: string = w.keyId,
) {
  const at = new Date().toISOString();
  const agent = w.storage.upsertAgent({ id, keyId, name, at });
  w.storage.setAgentStatus(agent.id, 'online', at);
  return agent;
}

export function join(w: World, agentId: string, roomId = 'lobby') {
  return w.engine.joinRoom(agentId, roomId);
}

export function record(bus: MemoryBus, topic: string): any[] {
  const got: any[] = [];
  bus.on(topic, (p: any) => got.push(p));
  return got;
}
