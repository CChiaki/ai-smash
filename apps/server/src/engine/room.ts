import type { AgentPresence, Attachment, ChatMessage, Limits } from '@ai-smash/protocol';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { Bus } from '../bus.js';
import { Topics } from '../topics.js';
import type { Storage } from '../storage/types.js';
import type { AgentRow, RoomRow } from '../storage/types.js';
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
    if (!ra || ra.status === 'kicked') return; // kicked 行永久保留：被踢 Agent 不得通过重连清除
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
        ...(ra.status !== 'waiting' && this.inflight.has(this.key(roomId, ra.agentId))
          && this.runtime.get(this.key(roomId, ra.agentId))?.mentionActive ? { mentioned: true } : {}),
        latencyMs: this.deps.storage.lastPostedLatency(ra.agentId),
        score: score ? { total: score.total, tier: score.tier } : null,
      };
    });
  }

  // ---------- 消息写入 ----------

  humanPost(
    roomId: string, keyId: string, senderName: string, text: string, attachments?: Attachment[],
  ): ChatMessage {
    const room = this.deps.storage.getRoom(roomId);
    if (!room) throw new EngineError('not_found');
    // 规格 8.4：暂停 = 停止向 agent 派发，人类仍可发言（恢复时补派发）；只有归档才拒绝
    if (room.status === 'archived') throw new EngineError('archived');
    if (text.trim().length === 0 || text.length > this.limits.maxTextLen) {
      throw new EngineError('invalid');
    }
    if (!this.allowHuman(roomId, keyId)) throw new EngineError('throttled');
    const message = this.insertMessage(roomId, {
      kind: 'human', name: senderName,
    }, keyId, null, text, null, attachments);
    const mentions = this.resolveMentions(roomId, text);
    if (mentions.matched.length > 0) {
      for (const agent of mentions.matched) {
        this.dispatchMention(roomId, agent, message.id);
      }
    }
    if (mentions.unknown.length > 0) {
      this.systemNotice(roomId, `房间内没有叫 ${mentions.unknown.join('、')} 的 Agent`);
    }
    if (mentions.matched.length === 0 && mentions.unknown.length === 0) {
      this.dispatchForNewMessage(roomId, message); // 无 @：常规广播
    }
    return message;
  }

  agentSkip(agentId: string, eventId: string, _reason?: string): { status: 'skipped' } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { status: 'skipped' }; // 未知 eventId 视为已失效，静默忽略
    this.finishEvent(found.roomId, agentId, eventId, 'skipped', null, null);
    this.afterEvent(found.roomId, agentId, false);
    return { status: 'skipped' };
  }

  /** 流式增量：校验在途与累计上限（8000 字），通过则经 Bus 转发（规格 §3.1） */
  agentDelta(agentId: string, eventId: string, delta: string): { ok: boolean; roomId?: string } {
    const found = this.findInflight(agentId, eventId);
    if (!found) return { ok: false };
    const rt = this.runtimeOf(found.roomId, agentId);
    // 累计含被拒增量：一旦超限，该 event 的后续 delta 一律拒绝（测试「仍超，继续拒绝」）
    rt.deltaLen += delta.length;
    if (rt.deltaLen > 8000) return { ok: false };
    this.deps.bus.emit(Topics.postDelta, { roomId: found.roomId, agentId, delta });
    return { ok: true, roomId: found.roomId };
  }

  /** 2.2：Agent 上报思考/工具 trace——仅直播透传，不落库；单 event ≤20 条 */
  agentTrace(agentId: string, eventId: string, kind: 'thought' | 'tool', text: string): boolean {
    const found = this.findInflight(agentId, eventId);
    if (!found) return false;
    const rt = this.runtimeOf(found.roomId, agentId);
    if (rt.traceCount >= 20) return false;
    rt.traceCount += 1;
    this.deps.bus.emit(Topics.trace, { roomId: found.roomId, agentId, kind, text });
    return true;
  }

  // ---------- agent 发言 ----------

  agentPost(
    agentId: string, eventId: string, text: string, replyTo?: string, attachments?: Attachment[],
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
    if (text.trim().length === 0 || text.length > this.limits.maxTextLen) return reject('invalid');
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.consecutive >= this.limits.maxConsecutive) return reject('throttled');
    if (!this.allowRoomPost(roomId)) return reject('throttled');
    const chat = this.insertMessage(
      roomId, { kind: 'agent', name: agent.name },
      agent.keyId, agentId, text, replyTo ?? null, attachments,
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
      if (message.sender.agentId && message.sender.agentId === ra.agentId) continue; // 自我回声硬禁
      const k = this.key(roomId, ra.agentId);
      if (this.inflight.has(k)) {
        // 覆写 pending 的同时清掉 mentionBypass：新 pending 是普通消息，不得继承 @ 豁免
        this.runtimeOf(roomId, ra.agentId).pendingMessageId = message.id;
        this.runtimeOf(roomId, ra.agentId).mentionBypass = false;
        continue;
      }
      const rt = this.runtimeOf(roomId, ra.agentId);
      if (rt.cooldownUntil > Date.now()) {
        // 冷却排队：追问不丢，到期自动补派（多条只留最新）
        rt.pendingMessageId = message.id;
        this.armCooldownDispatch(roomId, ra.agentId);
        continue;
      }
      if (!this.canDispatch(roomId, ra.agentId)) continue;
      this.dispatchToAgent(roomId, ra.agentId, message.id, context);
    }
  }

  /** 解析人类消息中的 @提及：返回按名字匹配到的成员 Agent 与未匹配名字（规格 §2.2.1） */
  private resolveMentions(roomId: string, text: string): { matched: AgentRow[]; unknown: string[] } {
    const roster = this.deps.storage.listRoomAgents(roomId)
      .filter((ra) => ra.status !== 'kicked')
      .map((ra) => this.deps.storage.getAgent(ra.agentId))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    const matched: AgentRow[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    // @ 触发边界：@ 前不得为 ASCII 字母数字或 @（中文/CJK 标点/空白均视为边界，支持「你好@小豆」，
    // 同时不误伤邮箱 test@example.com）。引擎派发 / web 补全 MentionInput / web 高亮 ChatStream 三处一致，勿单边漂移
    for (const m of text.matchAll(/(?<![\w@])@([^\s@]{1,32})/g)) {
      const raw = m[1];
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const agent = roster.find((a) => a.name.toLowerCase() === key);
      if (agent && !matched.some((a) => a.id === agent.id)) matched.push(agent);
      else if (!agent) unknown.push(raw);
    }
    return { matched, unknown };
  }

  /** 系统提示消息：落库并广播给观测端，但不触发任何派发 */
  private systemNotice(roomId: string, text: string): void {
    this.insertMessage(roomId, { kind: 'system', name: 'system' }, null, null, text, null);
  }

  /** @定向派发：豁免冷却与连续上限；成员资格/在线/速率仍生效（规格 §2.2.2） */
  private dispatchMention(roomId: string, agent: AgentRow, messageId: string): void {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return;
    const ra = this.deps.storage.getRoomAgent(roomId, agent.id);
    if (!ra || ra.status !== 'active') {
      this.systemNotice(roomId, `房间内没有叫 ${agent.name} 的 Agent`);
      return;
    }
    if (agent.status === 'offline' || agent.status === 'error') {
      this.systemNotice(roomId, `${agent.name} 不在线`);
      return;
    }
    const rt = this.runtimeOf(roomId, agent.id);
    const cutoff = Date.now() - 60_000;
    rt.posts = rt.posts.filter((t) => t > cutoff);
    if (rt.posts.length >= this.limits.agentPerMinute) return; // 速率仍生效：静默跳过
    if (this.inflight.has(this.key(roomId, agent.id))) {
      // 在途：合并为 pending，并在其完成后的派发中豁免冷却/连续
      rt.mentionBypass = true;
      rt.pendingMessageId = messageId;
      return;
    }
    this.dispatchToAgent(roomId, agent.id, messageId, this.buildContext(roomId), { mentioned: true });
  }

  private dispatchToAgent(
    roomId: string, agentId: string, triggerMessageId: string,
    context: { messages: ChatMessage[]; truncated: boolean },
    opts?: { mentioned?: boolean },
  ): void {
    const k = this.key(roomId, agentId);
    if (this.inflight.has(k)) {
      // 覆写 pending 的同时清掉 mentionBypass：新 pending 是普通消息，不得继承 @ 豁免
      this.runtimeOf(roomId, agentId).pendingMessageId = triggerMessageId;
      this.runtimeOf(roomId, agentId).mentionBypass = false;
      return;
    }
    const room = this.deps.storage.getRoom(roomId)!;
    const triggerRow = this.deps.storage.getMessage(triggerMessageId);
    if (!triggerRow) return;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const eventId = newId('ev');
    this.deps.storage.insertEvent({ id: eventId, roomId, agentId, triggerMessageId, notifiedAt: nowIso, mentioned: opts?.mentioned ?? false });
    this.deps.storage.bumpStats(agentId, { delivered: 1 });
    const inflight: Inflight = {
      eventId, triggerMessageId, notifiedAt: now,
      timer: setTimeout(() => this.onDeadline(roomId, agentId, eventId), this.limits.deadlineMs),
    };
    inflight.timer?.unref?.();
    this.runtimeOf(roomId, agentId).deltaLen = 0; // 每次派发重置累计
    this.runtimeOf(roomId, agentId).traceCount = 0; // 2.2：每次派发重置 trace 计数
    this.runtimeOf(roomId, agentId).mentionActive = Boolean(opts?.mentioned); // 2.2：@ 徽章随派发置位
    this.clearCooldownTimer(roomId, agentId); // 冷却排队定时器作废：真实派发已建立
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
    this.emitPresence(roomId); // 2.2：派发成功即推送 presence，徽章/状态实时可见
  }

  private buildContext(roomId: string): { messages: ChatMessage[]; truncated: boolean } {
    const rows = this.deps.storage.listMessages(roomId, { limit: 50 });
    let messages = rows.map((row) => {
      const chat = toChatMessage(row);
      // 上下文只给 LLM 附件摘要：base64 掏空（占位计数），url 保留
      if (chat.attachments?.some((a) => a.base64)) {
        return {
          ...chat,
          attachments: chat.attachments.map((a) =>
            a.base64 ? { kind: a.kind, url: `[base64 附件 ×${Math.ceil(a.base64.length / 1000)}KB]` } : a,
          ),
        };
      }
      return chat;
    });
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
    attachments?: Attachment[],
  ): ChatMessage {
    const nowIso = new Date().toISOString();
    const row = this.deps.storage.insertMessage({
      roomId, senderKind: sender.kind, senderName: sender.name,
      agentId, keyId, text, replyTo, createdAt: nowIso, attachments,
    });
    if (replyTo) {
      const target = this.deps.storage.getMessage(replyTo);
      if (target?.agentId) this.deps.storage.bumpStats(target.agentId, { repliesReceived: 1 });
    }
    // 他人真正打断（消息即时派发或 agent 空闲）才重置连续发言计数（规格 8.3）；
    // 在途或冷却排队中缓冲的追问不打断：连续应答链持续累计，由 maxConsecutive 截断
    for (const ra of this.deps.storage.listRoomAgents(roomId)) {
      if (ra.agentId !== agentId) {
        const k = this.key(roomId, ra.agentId);
        const rt = this.runtime.get(k);
        if (rt && !this.inflight.has(k) && !rt.cooldownTimer) rt.consecutive = 0;
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
    this.runtimeOf(roomId, agentId).deltaLen = 0;
    this.runtimeOf(roomId, agentId).mentionActive = false; // 2.2：事件终态清除 @ 徽章
    this.clearCooldownTimer(roomId, agentId); // 防止排队定时器在事件终态后空转
  }

  private clearCooldownTimer(roomId: string, agentId: string): void {
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.cooldownTimer) {
      clearTimeout(rt.cooldownTimer);
      rt.cooldownTimer = null;
    }
  }

  private afterEvent(roomId: string, agentId: string, spoke: boolean): void {
    const rt = this.runtimeOf(roomId, agentId);
    const pending = rt.pendingMessageId;
    const bypass = rt.mentionBypass;
    rt.pendingMessageId = null;
    rt.mentionBypass = false;
    const blocked = spoke && rt.cooldownUntil > Date.now() && !bypass;
    if (pending && !blocked && this.canDispatch(roomId, agentId, { mention: bypass })) {
      this.dispatchToAgent(roomId, agentId, pending, this.buildContext(roomId), bypass ? { mentioned: true } : undefined);
    } else if (pending && blocked) {
      // 追问不丢：发言落入冷却时不再作废 pending，按剩余冷却重新排队补派
      // （覆盖 @提及作废排队定时器、在途期间到达的追问两种丢失路径）
      rt.pendingMessageId = pending;
      this.armCooldownDispatch(roomId, agentId);
    }
    this.emitPresence(roomId);
  }

  /** 冷却排队：按剩余冷却武装补派定时器（多条只留最新；到期经 canDispatch 常规校验后补派） */
  private armCooldownDispatch(roomId: string, agentId: string): void {
    const rt = this.runtimeOf(roomId, agentId);
    if (rt.cooldownTimer) return;
    const delay = Math.max(50, rt.cooldownUntil - Date.now());
    rt.cooldownTimer = setTimeout(() => {
      rt.cooldownTimer = null;
      const pending = rt.pendingMessageId;
      rt.pendingMessageId = null;
      if (pending && this.canDispatch(roomId, agentId)) {
        this.dispatchToAgent(roomId, agentId, pending, this.buildContext(roomId));
      }
    }, delay);
    rt.cooldownTimer.unref?.();
  }

  private runtimeOf(roomId: string, agentId: string): AgentRoomRuntime {
    const k = this.key(roomId, agentId);
    let rt = this.runtime.get(k);
    if (!rt) {
      rt = { cooldownUntil: 0, consecutive: 0, posts: [], pendingMessageId: null, mentionBypass: false, mentionActive: false, traceCount: 0, deltaLen: 0, cooldownTimer: null };
      this.runtime.set(k, rt);
    }
    return rt;
  }

  private canDispatch(roomId: string, agentId: string, opts?: { mention?: boolean }): boolean {
    const room = this.deps.storage.getRoom(roomId);
    if (!room || room.status !== 'active') return false;
    const agent = this.deps.storage.getAgent(agentId);
    if (!agent || agent.status === 'offline' || agent.status === 'error' || agent.status === 'waiting') return false;
    const ra = this.deps.storage.getRoomAgent(roomId, agentId);
    if (!ra || ra.status !== 'active') return false;
    const rt = this.runtimeOf(roomId, agentId);
    if (!opts?.mention) {
      if (rt.cooldownUntil > Date.now()) return false;
      if (rt.consecutive >= this.limits.maxConsecutive) return false;
    }
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
  mentionBypass: boolean;
  mentionActive: boolean;
  traceCount: number;
  deltaLen: number;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
}
