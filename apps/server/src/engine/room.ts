import type { AgentPresence, ChatMessage, Limits } from '@ai-smash/protocol';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { Bus } from '../bus.js';
import { Topics } from '../topics.js';
import type { Storage } from '../storage/types.js';
import type { RoomRow } from '../storage/types.js';
import { toChatMessage } from './chat.js';
import { newId } from '../ids.js';
import { EngineError } from './errors.js';

export interface EngineDeps {
  storage: Storage;
  bus: Bus;
  limits?: Partial<Limits>;
}

export class RoomEngine {
  private limits: Limits;
  private inflight = new Map<string, Inflight>();      // `${roomId}:${agentId}` -> 在途事件
  private runtime = new Map<string, AgentRoomRuntime>();  // `${roomId}:${agentId}` -> 运行时状态
  private roomPosts = new Map<string, number[]>();        // roomId -> 最近 agent 发言时间
  private humanPosts = new Map<string, number[]>();       // `${roomId}:${keyId}` -> 最近人类发言时间

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
    // 安全：私有房仅 owner key 与已加入成员 key 的 agent 可加入（人类侧已有同样 ACL）
    if (room.visibility === 'private') {
      const allowed
        = room.ownerKeyId === agent.keyId || !!this.deps.storage.getMember(roomId, agent.keyId);
      if (!allowed) throw new EngineError('forbidden');
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
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (inflight) this.finishEvent(roomId, agentId, inflight.eventId, 'skipped', 'agent_left', null);
    this.deps.storage.removeRoomAgent(roomId, agentId);
    this.clearInflight(roomId, agentId);
    this.promoteWaiting(roomId);
    this.emitPresence(roomId);
  }

  kickAgent(roomId: string, agentId: string): void {
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status === 'kicked') return;
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (inflight) this.finishEvent(roomId, agentId, inflight.eventId, 'rejected', 'kicked', null);
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
    const latest = this.deps.storage.listMessages(roomId, { limit: 1 }).at(-1);
    if (latest) this.dispatchForNewMessage(roomId, toChatMessage(latest));
  }

  // 规格 8.4：上限调高触发候补转正；archived 是终态，拒绝任何设置变更
  updateRoomSettings(
    roomId: string,
    patch: Partial<Pick<RoomRow, 'title' | 'topic' | 'status' | 'cooldownMs' | 'maxAgents'>>,
  ): RoomRow {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    if (room.status === 'archived' || patch.status === 'archived') throw new EngineError('archived');
    const updated = this.deps.storage.updateRoom(roomId, patch);
    if (patch.maxAgents !== undefined) this.promoteWaiting(roomId);
    this.deps.bus.emit(Topics.roomUpdate, { room: this.deps.storage.getRoom(roomId)! });
    return updated;
  }

  // ---------- 在场与状态 ----------

  listPresence(roomId: string): AgentPresence[] {
    return this.deps.storage.listRoomAgents(roomId).filter((ra) => ra.status !== 'kicked').map((ra) => {
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

  // ---------- 消息写入 ----------

  humanPost(roomId: string, keyId: string, senderName: string, text: string): ChatMessage {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    // 规格 8.4：暂停 = 停止向 agent 派发，人类仍可发言（恢复时补派发）；只有归档才拒绝
    if (room.status === 'archived') throw new EngineError('archived');
    if (text.length === 0 || text.length > this.limits.maxTextLen) {
      throw new EngineError('invalid');
    }
    if (!this.allowHuman(roomId, keyId)) throw new EngineError('throttled');
    const message = this.insertMessage(roomId, {
      kind: 'human', name: senderName,
    }, keyId, null, text, null);
    this.dispatchForNewMessage(roomId, message);
    return message;
  }

  agentSkip(agentId: string, eventId: string, _reason?: string): { status: 'skipped' } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { status: 'skipped' }; // 未知 eventId 视为已失效，静默忽略
    this.finishEvent(found.roomId, agentId, eventId, 'skipped', null, null);
    this.afterEvent(found.roomId, agentId, false);
    return { status: 'skipped' };
  }

  // ---------- agent 发言 ----------

  agentPost(
    agentId: string, eventId: string, text: string, replyTo?: string,
  ): { status: 'posted' } | { status: 'rejected'; reason: 'stale' | 'invalid' | 'throttled' | 'paused' } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { status: 'rejected', reason: 'stale' };
    const { roomId, inflight } = found;
    const room = this.deps.storage.getRoom(roomId)!;
    const agent = this.deps.storage.getAgent(agentId)!;
    const latencyMs = Date.now() - inflight.notifiedAt;
    const reject = (reason: 'invalid' | 'throttled' | 'paused') => {
      this.finishEvent(roomId, agentId, eventId, 'rejected', reason, latencyMs);
      this.afterEvent(roomId, agentId, false);
      return { status: 'rejected' as const, reason };
    };
    if (room.status !== 'active') return reject('paused');
    if (text.length === 0 || text.length > this.limits.maxTextLen) return reject('invalid');
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.consecutive >= this.limits.maxConsecutive) return reject('throttled');
    if (!this.allowRoomPost(roomId)) return reject('throttled');
    const chat = this.insertMessage(
      roomId, { kind: 'agent', name: agent.name },
      agent.keyId, agentId, text, replyTo ?? null,
    );
    rt.consecutive += 1;
    rt.cooldownUntil = Date.now() + room.cooldownMs;
    rt.posts.push(Date.now());
    this.finishEvent(roomId, agentId, eventId, 'posted', null, latencyMs);
    this.dispatchForNewMessage(roomId, chat);
    this.afterEvent(roomId, agentId, true);
    return { status: 'posted' };
  }

  // ---------- 派发 ----------

  dispatchForNewMessage(roomId: string, message: ChatMessage): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return;
    // 规格 8.2(2)：同一触发消息的上下文序列化一次后复用
    const context = this.buildContext(roomId);
    for (const ra of this.deps.storage.listRoomAgents(roomId)) {
      if (ra.status !== 'active') continue;
      const k = this.key(roomId, ra.agentId);
      if (this.inflight.has(k)) {
        this.runtimeOf(roomId, ra.agentId).pendingMessageId = message.id;
        continue;
      }
      if (!this.canDispatch(roomId, ra.agentId)) continue;
      this.dispatchToAgent(roomId, ra.agentId, message.id, context);
    }
  }

  private dispatchToAgent(
    roomId: string, agentId: string, triggerMessageId: string,
    context: { messages: ChatMessage[]; truncated: boolean },
  ): void {
    const k = this.key(roomId, agentId);
    if (this.inflight.has(k)) {
      this.runtimeOf(roomId, agentId).pendingMessageId = triggerMessageId;
      return;
    }
    const room = this.deps.storage.getRoom(roomId)!;
    const triggerRow = this.deps.storage.getMessage(triggerMessageId);
    if (!triggerRow) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const eventId = newId('ev');
    this.deps.storage.insertEvent({ id: eventId, roomId, agentId, triggerMessageId, notifiedAt: nowIso });
    this.deps.storage.bumpStats(agentId, { delivered: 1 });
    const inflight: Inflight = {
      eventId, triggerMessageId, notifiedAt: now,
      timer: setTimeout(() => this.onDeadline(roomId, agentId, eventId), this.limits.deadlineMs),
    };
    inflight.timer?.unref?.();
    this.inflight.set(this.key(roomId, agentId), inflight);
    this.deps.bus.emit(Topics.eventDispatch, {
      eventId,
      agentId,
      roomId,
      trigger: {
        kind: 'message',
        messageId: triggerRow.id,
        sender: {
          kind: triggerRow.senderKind,
          name: triggerRow.senderName,
          ...(triggerRow.agentId ? { agentId: triggerRow.agentId } : {}),
        },
      },
      room: { title: room.title, topic: room.topic },
      context,
      deadlineAt: new Date(now + this.limits.deadlineMs).toISOString(),
    });
  }

  private buildContext(roomId: string): { messages: ChatMessage[]; truncated: boolean } {
    const rows = this.deps.storage.listMessages(roomId, { limit: 50 });
    let messages = rows.map(toChatMessage);
    let truncated = false;
    let size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    while (size > this.limits.contextBytes && messages.length > 1) {
      messages = messages.slice(1);
      truncated = true;
      size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    }
    return { messages, truncated };
  }

  // ---------- 内部工具 ----------

  private insertMessage(
    roomId: string, sender: { kind: ChatMessage['sender']['kind']; name: string },
    keyId: string | null, agentId: string | null, text: string, replyTo: string | null,
  ): ChatMessage {
    const nowIso = new Date().toISOString();
    const row = this.deps.storage.insertMessage({
      roomId, senderKind: sender.kind, senderName: sender.name,
      agentId, keyId, text, replyTo, createdAt: nowIso,
    });
    if (replyTo) {
      const target = this.deps.storage.getMessage(replyTo);
      if (target?.agentId) this.deps.storage.bumpStats(target.agentId, { repliesReceived: 1 });
    }
    // 任何他人发言都会打断连续发言计数（规格 8.3）
    for (const ra of this.deps.storage.listRoomAgents(roomId)) {
      if (ra.agentId !== agentId) {
        const rt = this.runtime.get(this.key(roomId, ra.agentId));
        if (rt) rt.consecutive = 0;
      }
    }
    const chat = toChatMessage(row);
    this.deps.bus.emit(Topics.messageNew, { message: chat });
    return chat;
  }

  private findInflight(agentId: string, eventId: string): { roomId: string; inflight: Inflight } | undefined {
    for (const [k, inflight] of this.inflight) {
      if (inflight.eventId === eventId && k.endsWith(`:${agentId}`)) {
        return { roomId: k.slice(0, k.length - agentId.length - 1), inflight };
      }
    }
    return undefined;
  }

  private finishEvent(
    roomId: string, agentId: string, eventId: string,
    status: 'posted' | 'skipped' | 'timeout' | 'rejected',
    reason: string | null, latencyMs: number | null,
  ): void {
    this.deps.storage.decideEvent(eventId, status, reason, new Date().toISOString(), latencyMs);
    const k = this.key(roomId, agentId);
    const inflight = this.inflight.get(k);
    if (inflight?.eventId === eventId) {
      if (inflight.timer) clearTimeout(inflight.timer);
      this.inflight.delete(k);
    }
    if (status === 'posted') this.deps.storage.bumpStats(agentId, { posted: 1 });
    else if (status === 'skipped') this.deps.storage.bumpStats(agentId, { skipped: 1 });
    else if (status === 'timeout') this.deps.storage.bumpStats(agentId, { timeout: 1 });
    else if (status === 'rejected') {
      this.deps.storage.bumpStats(agentId, {
        rejected: 1, ...(reason === 'throttled' ? { throttled: 1 } : {}),
      });
    }
  }

  private afterEvent(roomId: string, agentId: string, spoke: boolean): void {
    const rt = this.runtimeOf(roomId, agentId);
    const pending = rt.pendingMessageId;
    rt.pendingMessageId = null;
    const blocked = spoke && rt.cooldownUntil > Date.now();
    if (pending && !blocked && this.canDispatch(roomId, agentId)) {
      this.dispatchToAgent(roomId, agentId, pending, this.buildContext(roomId));
    }
    this.emitPresence(roomId);
  }

  private runtimeOf(roomId: string, agentId: string): AgentRoomRuntime {
    const k = this.key(roomId, agentId);
    let rt = this.runtime.get(k);
    if (!rt) {
      rt = { cooldownUntil: 0, consecutive: 0, posts: [], pendingMessageId: null };
      this.runtime.set(k, rt);
    }
    return rt;
  }

  private canDispatch(roomId: string, agentId: string): boolean {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return false;
    const agent = this.deps.storage.getAgent(agentId);
    if (!agent || agent.status === 'offline' || agent.status === 'error' || agent.status === 'waiting') return false;
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status !== 'active') return false;
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.cooldownUntil > Date.now()) return false;
    if (rt.consecutive >= this.limits.maxConsecutive) return false;
    const cutoff = Date.now() - 60_000;
    rt.posts = rt.posts.filter((t) => t > cutoff);
    if (rt.posts.length >= this.limits.agentPerMinute) return false;
    return true;
  }

  private allowHuman(roomId: string, keyId: string): boolean {
    const k = `h:${roomId}:${keyId}`;
    const cutoff = Date.now() - 60_000;
    const arr = (this.humanPosts.get(k) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limits.humanPerMinute) return false;
    arr.push(Date.now());
    this.humanPosts.set(k, arr);
    return true;
  }

  // ---------- 超时 ----------

  private onDeadline(roomId: string, agentId: string, eventId: string): void {
    const inflight = this.inflight.get(this.key(roomId, agentId));
    if (!inflight || inflight.eventId !== eventId) return;
    this.finishEvent(roomId, agentId, eventId, 'timeout', null, null);
    this.afterEvent(roomId, agentId, false);
  }

  // ---------- 速率 ----------

  private allowRoomPost(roomId: string): boolean {
    const cutoff = Date.now() - 10_000;
    const arr = (this.roomPosts.get(roomId) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.limits.roomMessagesPer10s) return false;
    arr.push(Date.now());
    this.roomPosts.set(roomId, arr);
    return true;
  }

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

interface AgentRoomRuntime {
  cooldownUntil: number;
  consecutive: number;
  posts: number[];
  pendingMessageId: string | null;
}
