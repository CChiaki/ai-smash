import type { AgentPresence, Limits } from '@ai-smash/protocol';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { Bus } from '../bus.js';
import { Topics } from '../topics.js';
import type { Storage } from '../storage/types.js';
import { EngineError } from './errors.js';

export interface EngineDeps {
  storage: Storage;
  bus: Bus;
  limits?: Partial<Limits>;
}

export class RoomEngine {
  private limits: Limits;
  private inflight = new Map<string, Inflight>();      // `${roomId}:${agentId}` -> 在途事件

  constructor(private deps: EngineDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  // ---------- 成员关系 ----------

  joinRoom(agentId: string, roomId: string): { status: 'active' | 'waiting' } {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    if (room.status === 'archived') throw new EngineError('archived');
    const agent = this.deps.storage.getAgent(agentId);
    if (!agent) throw new EngineError('not_found');
    const existing = this.deps.storage.getRoomAgent(roomId, agentId);
    if (existing?.status === 'kicked') throw new EngineError('kicked');
    if (existing) return { status: existing.status === 'waiting' ? 'waiting' : 'active' };
    if (this.deps.storage.countAgentsByKey(agent.keyId) > this.limits.keyAgentsGlobal) {
      throw new EngineError('forbidden');
    }
    if (this.deps.storage.countKeyAgentsInRoom(roomId, agent.keyId) >= this.limits.keyAgentsPerRoom) {
      throw new EngineError('forbidden');
    }
    const at = new Date().toISOString();
    const status
      = this.deps.storage.countRoomAgents(roomId, 'active') < room.maxAgents ? 'active' : 'waiting';
    this.deps.storage.addRoomAgent(roomId, agentId, status, at);
    this.emitPresence(roomId);
    return { status };
  }

  leaveRoom(agentId: string, roomId: string): void {
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra) return;
    this.deps.storage.removeRoomAgent(roomId, agentId);
    this.clearInflight(roomId, agentId);
    this.promoteWaiting(roomId);
    this.emitPresence(roomId);
  }

  kickAgent(roomId: string, agentId: string): void {
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status === 'kicked') return;
    this.deps.storage.setRoomAgentStatus(roomId, agentId, 'kicked');
    this.clearInflight(roomId, agentId);
    this.deps.bus.emit(Topics.agentState, { agentId, roomId, kicked: true });
    this.promoteWaiting(roomId);
    this.emitPresence(roomId);
  }

  pauseRoom(roomId: string): void {
    const room = this.deps.storage.updateRoom(roomId, { status: 'paused' });
    this.deps.bus.emit(Topics.roomUpdate, { room });
  }

  resumeRoom(roomId: string): void {
    const room = this.deps.storage.updateRoom(roomId, { status: 'active' });
    this.deps.bus.emit(Topics.roomUpdate, { room });
    // 恢复时以最新一条消息补派发（规格 8.2）；派发方法在 Task 7 实现
  }

  // ---------- 在场与状态 ----------

  listPresence(roomId: string): AgentPresence[] {
    return this.deps.storage.listRoomAgents(roomId).map((ra) => {
      const agent = this.deps.storage.getAgent(ra.agentId)!;
      const score = this.deps.storage.getScore(ra.agentId) ?? null;
      const thinking = this.inflight.has(this.key(roomId, ra.agentId));
      const status = ra.status === 'waiting'
        ? 'waiting'
        : thinking
          ? 'thinking'
          : agent.status;
      return {
        agentId: ra.agentId,
        name: agent.name,
        status,
        latencyMs: this.deps.storage.lastPostedLatency(ra.agentId),
        score: score ? { total: score.total, tier: score.tier } : null,
      };
    });
  }

  // ---------- 内部工具 ----------

  private key(roomId: string, agentId: string): string {
    return `${roomId}:${agentId}`;
  }

  private emitPresence(roomId: string): void {
    this.deps.bus.emit(Topics.presence, { roomId });
  }

  private clearInflight(roomId: string, agentId: string): void {
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (inflight?.timer) clearTimeout(inflight.timer);
    this.inflight.delete(this.key(roomId, agentId));
  }

  private promoteWaiting(roomId: string): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) return;
    let active = this.deps.storage.countRoomAgents(roomId, 'active');
    for (const ra of this.deps.storage.listWaitingAgents(roomId)) {
      if (active >= room.maxAgents) break;
      this.deps.storage.setRoomAgentStatus(roomId, ra.agentId, 'active');
      active += 1;
    }
  }
}

interface Inflight {
  eventId: string;
  triggerMessageId: string | null;
  notifiedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
