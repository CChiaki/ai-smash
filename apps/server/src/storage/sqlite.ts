import Database from 'better-sqlite3';
import { newId } from '../ids.js';
import type {
  AgentRow, AuditInput, AuditRow, EventMetrics, EventRow, KeyRow, MessageRow,
  NewEventInput, NewMessageInput, RoomAgentRow, RoomMemberRow, RoomRow,
  ScoreRow, StatsPatch, Storage,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, label TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
  last_seen_at TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', last_seen_at TEXT,
  created_at TEXT NOT NULL, UNIQUE(key_id, name)
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, topic TEXT,
  visibility TEXT NOT NULL DEFAULT 'private', owner_key_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', invite_code TEXT UNIQUE,
  cooldown_ms INTEGER NOT NULL DEFAULT 10000, max_agents INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_agents (
  room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL, key_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL, PRIMARY KEY (room_id, key_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
  sender_kind TEXT NOT NULL, sender_name TEXT NOT NULL,
  agent_id TEXT, key_id TEXT, text TEXT NOT NULL, reply_to TEXT,
  deleted_at TEXT, created_at TEXT NOT NULL, UNIQUE(room_id, seq)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  trigger_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered',
  reason TEXT, notified_at TEXT NOT NULL, decided_at TEXT, latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, key_id)
);
CREATE TABLE IF NOT EXISTS agent_stats (
  agent_id TEXT PRIMARY KEY, delivered INTEGER NOT NULL DEFAULT 0,
  posted INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  timeout INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  throttled INTEGER NOT NULL DEFAULT 0, replies_received INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_scores (
  agent_id TEXT PRIMARY KEY, behavior INTEGER NOT NULL, heat INTEGER NOT NULL,
  total INTEGER NOT NULL, tier TEXT NOT NULL, likes_7d INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, target_type TEXT NOT NULL,
  target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, notified_at);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, notified_at);
CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(key_id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_key_time ON reactions(key_id, created_at);
`;

export class SqliteStorage implements Storage {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- 行映射 ----------

  private mapKey(r: any): KeyRow {
    return {
      id: r.id, hash: r.hash, label: r.label, status: r.status,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, notes: r.notes,
    };
  }

  private mapAgent(r: any): AgentRow {
    return {
      id: r.id, keyId: r.key_id, name: r.name, status: r.status,
      lastSeenAt: r.last_seen_at, createdAt: r.created_at,
    };
  }

  // ---------- keys ----------

  createKey(input: { id: string; hash: string; label: string | null; createdAt: string }): KeyRow {
    this.db.prepare(
      `INSERT INTO keys (id, hash, label, created_at) VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.hash, input.label, input.createdAt);
    return {
      id: input.id, hash: input.hash, label: input.label,
      status: 'active', createdAt: input.createdAt, lastSeenAt: null, notes: null,
    };
  }

  getKeyByHash(hash: string): KeyRow | undefined {
    const r = this.db.prepare(`SELECT * FROM keys WHERE hash = ?`).get(hash);
    return r ? this.mapKey(r) : undefined;
  }

  getKey(id: string): KeyRow | undefined {
    const r = this.db.prepare(`SELECT * FROM keys WHERE id = ?`).get(id);
    return r ? this.mapKey(r) : undefined;
  }

  setKeyStatus(id: string, status: 'active' | 'banned'): void {
    this.db.prepare(`UPDATE keys SET status = ? WHERE id = ?`).run(status, id);
  }

  touchKey(id: string, at: string): void {
    this.db.prepare(`UPDATE keys SET last_seen_at = ? WHERE id = ?`).run(at, id);
  }

  listKeys(): KeyRow[] {
    return (this.db.prepare(`SELECT * FROM keys ORDER BY created_at`).all() as any[]).map((r) => this.mapKey(r));
  }

  // ---------- agents ----------

  upsertAgent(input: { id?: string; keyId: string; name: string; at: string }): AgentRow {
    const existing = this.db.prepare(
      `SELECT * FROM agents WHERE key_id = ? AND name = ?`,
    ).get(input.keyId, input.name) as any;
    if (existing) {
      this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(input.at, existing.id);
      return this.mapAgent(existing);
    }
    if (input.id) {
      const clash = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(input.id) as any;
      if (clash && clash.key_id !== input.keyId) throw new Error('agent_id_mismatch');
    }
    const id = input.id ?? newId('ag');
    this.db.prepare(
      `INSERT INTO agents (id, key_id, name, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.keyId, input.name, input.at, input.at);
    return { id, keyId: input.keyId, name: input.name, status: 'offline', lastSeenAt: input.at, createdAt: input.at };
  }

  getAgent(id: string): AgentRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
    return r ? this.mapAgent(r) : undefined;
  }

  setAgentStatus(id: string, status: AgentRow['status'], at: string): void {
    this.db.prepare(`UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?`).run(status, at, id);
  }

  listAgentsByKey(keyId: string): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE key_id = ? ORDER BY created_at`).all(keyId) as any[])
      .map((r) => this.mapAgent(r));
  }

  countAgentsByKey(keyId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM agents WHERE key_id = ?`).get(keyId) as any;
    return r.n;
  }

  listAgents(): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY created_at`).all() as any[]).map((r) => this.mapAgent(r));
  }

  // ---------- 行映射 ----------

  private mapRoom(r: any): RoomRow {
    return {
      id: r.id, title: r.title, topic: r.topic, visibility: r.visibility,
      ownerKeyId: r.owner_key_id, status: r.status, inviteCode: r.invite_code,
      cooldownMs: r.cooldown_ms, maxAgents: r.max_agents, createdAt: r.created_at,
    };
  }

  private mapRoomAgent(r: any): RoomAgentRow {
    return { roomId: r.room_id, agentId: r.agent_id, status: r.status, joinedAt: r.joined_at };
  }

  // ---------- rooms ----------

  private insertRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string | null;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow {
    this.db.prepare(
      `INSERT INTO rooms (id, title, topic, visibility, owner_key_id, invite_code, cooldown_ms, max_agents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.title, input.topic, input.visibility,
      input.ownerKeyId, input.inviteCode, input.cooldownMs, input.maxAgents, input.at,
    );
    return {
      id: input.id, title: input.title, topic: input.topic, visibility: input.visibility,
      ownerKeyId: input.ownerKeyId, status: 'active', inviteCode: input.inviteCode,
      cooldownMs: input.cooldownMs, maxAgents: input.maxAgents, createdAt: input.at,
    };
  }

  ensureLobby(input: { title: string; maxAgents: number; at: string }): RoomRow {
    const existing = this.getRoom('lobby');
    if (existing) return existing;
    return this.insertRoom({
      id: 'lobby', title: input.title, topic: null, visibility: 'public',
      ownerKeyId: null, inviteCode: null, cooldownMs: 10000, maxAgents: input.maxAgents, at: input.at,
    });
  }

  createRoom(input: {
    id: string; title: string; topic: string | null;
    visibility: 'public' | 'private'; ownerKeyId: string;
    inviteCode: string | null; cooldownMs: number; maxAgents: number; at: string;
  }): RoomRow {
    return this.insertRoom(input);
  }

  getRoom(id: string): RoomRow | undefined {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id);
    return r ? this.mapRoom(r) : undefined;
  }

  getRoomByInviteCode(code: string): RoomRow | undefined {
    const r = this.db.prepare(`SELECT * FROM rooms WHERE invite_code = ?`).get(code);
    return r ? this.mapRoom(r) : undefined;
  }

  listRooms(visibility?: 'public' | 'private'): RoomRow[] {
    const rows = visibility
      ? this.db.prepare(`SELECT * FROM rooms WHERE visibility = ? ORDER BY created_at`).all(visibility)
      : this.db.prepare(`SELECT * FROM rooms ORDER BY created_at`).all();
    return (rows as any[]).map((r) => this.mapRoom(r));
  }

  updateRoom(
    id: string,
    patch: Partial<Pick<RoomRow, 'title' | 'topic' | 'status' | 'cooldownMs' | 'maxAgents'>>,
  ): RoomRow {
    const col: Record<string, string> = {
      title: 'title', topic: 'topic', status: 'status',
      cooldownMs: 'cooldown_ms', maxAgents: 'max_agents',
    };
    for (const [k, v] of Object.entries(patch)) {
      this.db.prepare(`UPDATE rooms SET ${col[k]} = ? WHERE id = ?`).run(v, id);
    }
    return this.getRoom(id)!;
  }

  // ---------- room_agents ----------

  addRoomAgent(roomId: string, agentId: string, status: 'active' | 'waiting', at: string): void {
    this.db.prepare(
      `INSERT INTO room_agents (room_id, agent_id, status, joined_at) VALUES (?, ?, ?, ?)`,
    ).run(roomId, agentId, status, at);
  }

  getRoomAgent(roomId: string, agentId: string): RoomAgentRow | undefined {
    const r = this.db.prepare(
      `SELECT * FROM room_agents WHERE room_id = ? AND agent_id = ?`,
    ).get(roomId, agentId);
    return r ? this.mapRoomAgent(r) : undefined;
  }

  setRoomAgentStatus(roomId: string, agentId: string, status: RoomAgentRow['status']): void {
    this.db.prepare(
      `UPDATE room_agents SET status = ? WHERE room_id = ? AND agent_id = ?`,
    ).run(status, roomId, agentId);
  }

  removeRoomAgent(roomId: string, agentId: string): void {
    this.db.prepare(
      `DELETE FROM room_agents WHERE room_id = ? AND agent_id = ?`,
    ).run(roomId, agentId);
  }

  listRoomAgents(roomId: string): RoomAgentRow[] {
    return (
      this.db.prepare(`SELECT * FROM room_agents WHERE room_id = ? ORDER BY joined_at`).all(roomId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  listWaitingAgents(roomId: string): RoomAgentRow[] {
    return (
      this.db.prepare(
        `SELECT * FROM room_agents WHERE room_id = ? AND status = 'waiting' ORDER BY joined_at`,
      ).all(roomId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  listRoomsOfAgent(agentId: string): RoomAgentRow[] {
    return (
      this.db.prepare(`SELECT * FROM room_agents WHERE agent_id = ?`).all(agentId) as any[]
    ).map((r) => this.mapRoomAgent(r));
  }

  countRoomAgents(roomId: string, status: RoomAgentRow['status']): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM room_agents WHERE room_id = ? AND status = ?`,
      ).get(roomId, status) as any
    ).c;
  }

  countKeyAgentsInRoom(roomId: string, keyId: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM room_agents ra JOIN agents a ON a.id = ra.agent_id
         WHERE ra.room_id = ? AND a.key_id = ? AND ra.status IN ('active', 'waiting')`,
      ).get(roomId, keyId) as any
    ).c;
  }

  // ---------- members ----------

  addMember(roomId: string, keyId: string, role: 'host' | 'member', at: string): void {
    this.db.prepare(
      `INSERT INTO room_members (room_id, key_id, role, joined_at) VALUES (?, ?, ?, ?)`,
    ).run(roomId, keyId, role, at);
  }

  getMember(roomId: string, keyId: string): RoomMemberRow | undefined {
    const r = this.db.prepare(
      `SELECT * FROM room_members WHERE room_id = ? AND key_id = ?`,
    ).get(roomId, keyId) as any;
    return r
      ? { roomId: r.room_id, keyId: r.key_id, role: r.role, joinedAt: r.joined_at }
      : undefined;
  }

  removeMember(roomId: string, keyId: string): void {
    this.db.prepare(
      `DELETE FROM room_members WHERE room_id = ? AND key_id = ?`,
    ).run(roomId, keyId);
  }

  // ---------- 行映射 ----------

  private mapMessage(r: any): MessageRow {
    return {
      id: r.id, roomId: r.room_id, seq: r.seq, senderKind: r.sender_kind,
      senderName: r.sender_name, agentId: r.agent_id, keyId: r.key_id,
      text: r.text, replyTo: r.reply_to, deletedAt: r.deleted_at, createdAt: r.created_at,
    };
  }

  // ---------- messages ----------

  insertMessage(input: NewMessageInput): MessageRow {
    const id = newId('m');
    const seq = (
      this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE room_id = ?`)
        .get(input.roomId) as any
    ).s + 1;
    this.db.prepare(
      `INSERT INTO messages (id, room_id, seq, sender_kind, sender_name, agent_id, key_id, text, reply_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.roomId, seq, input.senderKind, input.senderName,
      input.agentId, input.keyId, input.text, input.replyTo, input.createdAt,
    );
    return {
      id, roomId: input.roomId, seq, senderKind: input.senderKind, senderName: input.senderName,
      agentId: input.agentId, keyId: input.keyId, text: input.text,
      replyTo: input.replyTo, deletedAt: null, createdAt: input.createdAt,
    };
  }

  getMessage(id: string): MessageRow | undefined {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
    return r ? this.mapMessage(r) : undefined;
  }

  listMessages(roomId: string, opts?: { afterSeq?: number; limit?: number }): MessageRow[] {
    const limit = opts?.limit ?? 200;
    const rows = opts?.afterSeq !== undefined
      ? this.db.prepare(
          `SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        ).all(roomId, opts.afterSeq, limit)
      : this.db.prepare(
          `SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`,
        ).all(roomId, limit);
    return (rows as any[]).map((r) => this.mapMessage(r));
  }

  softDeleteMessage(id: string, at: string): void {
    this.db.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`).run(at, id);
  }

  countRepliesTo(agentId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM messages r JOIN messages m ON r.reply_to = m.id
         WHERE m.agent_id = ? AND r.created_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
  }

  countMessagesSince(sinceIso: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?`).get(sinceIso) as any
    ).c;
  }

  // ---------- events ----------

  insertEvent(input: NewEventInput): void {
    this.db.prepare(
      `INSERT INTO events (id, room_id, agent_id, trigger_message_id, notified_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.roomId, input.agentId, input.triggerMessageId, input.notifiedAt);
  }

  listEvents(opts?: { roomId?: string; agentId?: string; limit?: number }): EventRow[] {
    const clauses: string[] = [];
    const params: any[] = [];
    if (opts?.roomId) { clauses.push('room_id = ?'); params.push(opts.roomId); }
    if (opts?.agentId) { clauses.push('agent_id = ?'); params.push(opts.agentId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 100);
    return (
      this.db.prepare(
        `SELECT * FROM events ${where} ORDER BY notified_at DESC LIMIT ?`,
      ).all(...params) as any[]
    ).map((r) => ({
      id: r.id, roomId: r.room_id, agentId: r.agent_id,
      triggerMessageId: r.trigger_message_id, status: r.status, reason: r.reason,
      notifiedAt: r.notified_at, decidedAt: r.decided_at, latencyMs: r.latency_ms,
    }));
  }

  getEvent(id: string): EventRow | undefined {
    const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as any;
    return r
      ? {
          id: r.id, roomId: r.room_id, agentId: r.agent_id,
          triggerMessageId: r.trigger_message_id, status: r.status, reason: r.reason,
          notifiedAt: r.notified_at, decidedAt: r.decided_at, latencyMs: r.latency_ms,
        }
      : undefined;
  }

  decideEvent(
    id: string, status: EventRow['status'], reason: string | null,
    decidedAt: string, latencyMs: number | null,
  ): void {
    this.db.prepare(
      `UPDATE events SET status = ?, reason = ?, decided_at = ?, latency_ms = ? WHERE id = ?`,
    ).run(status, reason, decidedAt, latencyMs, id);
  }

  markAllDeliveredAsTimeout(at: string): number {
    const r = this.db.prepare(
      `UPDATE events SET status = 'timeout', reason = 'server_restart', decided_at = ? WHERE status = 'delivered'`,
    ).run(at);
    return r.changes;
  }

  eventMetrics(agentId: string, sinceIso: string): EventMetrics {
    const m: EventMetrics = {
      delivered: 0, posted: 0, skipped: 0, timeout: 0, rejected: 0, throttled: 0, latencies: [],
    };
    for (const r of this.db.prepare(
      `SELECT status, COUNT(*) AS c FROM events WHERE agent_id = ? AND notified_at >= ? GROUP BY status`,
    ).all(agentId, sinceIso) as any[]) {
      if (r.status in m) (m as any)[r.status] = r.c;
    }
    // delivered = 派发总数（含已决事件），与规格「响应率 = 1 − (timeout+rejected)/delivered」分母一致；
    // GROUP BY status 只统计仍为 delivered 的未决事件，因此这里单独取总数。
    m.delivered = (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM events WHERE agent_id = ? AND notified_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
    m.throttled = (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM events
         WHERE agent_id = ? AND status = 'rejected' AND reason = 'throttled' AND notified_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
    m.latencies = (
      this.db.prepare(
        `SELECT latency_ms FROM events
         WHERE agent_id = ? AND status = 'posted' AND notified_at >= ? AND latency_ms IS NOT NULL
         ORDER BY latency_ms LIMIT 500`,
      ).all(agentId, sinceIso) as any[]
    ).map((r) => r.latency_ms);
    return m;
  }

  lastPostedLatency(agentId: string): number | null {
    const r = this.db.prepare(
      `SELECT latency_ms FROM events
       WHERE agent_id = ? AND status = 'posted' AND latency_ms IS NOT NULL
       ORDER BY notified_at DESC LIMIT 1`,
    ).get(agentId) as any;
    return r ? r.latency_ms : null;
  }

  // ---------- reactions ----------

  addReaction(messageId: string, keyId: string, at: string): boolean {
    try {
      this.db.prepare(
        `INSERT INTO reactions (message_id, key_id, created_at) VALUES (?, ?, ?)`,
      ).run(messageId, keyId, at);
      return true;
    } catch {
      return false;
    }
  }

  countLikes(messageId: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?`)
        .get(messageId) as any
    ).c;
  }

  countLikesByAgent(agentId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM reactions r JOIN messages m ON m.id = r.message_id
         WHERE m.agent_id = ? AND r.created_at >= ?`,
      ).get(agentId, sinceIso) as any
    ).c;
  }

  countLikesByKeySince(keyId: string, sinceIso: string): number {
    return (
      this.db.prepare(
        `SELECT COUNT(*) AS c FROM reactions WHERE key_id = ? AND created_at >= ?`,
      ).get(keyId, sinceIso) as any
    ).c;
  }

  // ---------- stats & scores ----------

  bumpStats(agentId: string, patch: StatsPatch): void {
    this.db.prepare(
      `INSERT INTO agent_stats (agent_id, delivered, posted, skipped, timeout, rejected, throttled, replies_received, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         delivered = delivered + excluded.delivered,
         posted = posted + excluded.posted,
         skipped = skipped + excluded.skipped,
         timeout = timeout + excluded.timeout,
         rejected = rejected + excluded.rejected,
         throttled = throttled + excluded.throttled,
         replies_received = replies_received + excluded.replies_received,
         updated_at = excluded.updated_at`,
    ).run(
      agentId, patch.delivered ?? 0, patch.posted ?? 0, patch.skipped ?? 0,
      patch.timeout ?? 0, patch.rejected ?? 0, patch.throttled ?? 0,
      patch.repliesReceived ?? 0, new Date().toISOString(),
    );
  }

  getStats(agentId: string): Required<StatsPatch> & { agentId: string } {
    const r = this.db.prepare(`SELECT * FROM agent_stats WHERE agent_id = ?`).get(agentId) as any;
    if (!r) {
      return {
        agentId, delivered: 0, posted: 0, skipped: 0,
        timeout: 0, rejected: 0, throttled: 0, repliesReceived: 0,
      };
    }
    return {
      agentId, delivered: r.delivered, posted: r.posted, skipped: r.skipped,
      timeout: r.timeout, rejected: r.rejected, throttled: r.throttled,
      repliesReceived: r.replies_received,
    };
  }

  upsertScore(row: ScoreRow): void {
    this.db.prepare(
      `INSERT INTO agent_scores (agent_id, behavior, heat, total, tier, likes_7d, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         behavior = excluded.behavior, heat = excluded.heat, total = excluded.total,
         tier = excluded.tier, likes_7d = excluded.likes_7d, computed_at = excluded.computed_at`,
    ).run(row.agentId, row.behavior, row.heat, row.total, row.tier, row.likes7d, row.computedAt);
  }

  getScore(agentId: string): ScoreRow | undefined {
    const r = this.db.prepare(`SELECT * FROM agent_scores WHERE agent_id = ?`).get(agentId) as any;
    return r
      ? {
          agentId: r.agent_id, behavior: r.behavior, heat: r.heat, total: r.total,
          tier: r.tier, likes7d: r.likes_7d, computedAt: r.computed_at,
        }
      : undefined;
  }

  topScores(n: number): ScoreRow[] {
    return (
      this.db.prepare(
        // 规格 9.3：events 不足 20（scoring 档）的 agent 不计入榜单；并列按 computed_at 降序稳定排序
        `SELECT * FROM agent_scores WHERE tier <> 'scoring' ORDER BY total DESC, computed_at DESC LIMIT ?`,
      ).all(n) as any[]
    ).map((r) => ({
      agentId: r.agent_id, behavior: r.behavior, heat: r.heat, total: r.total,
      tier: r.tier, likes7d: r.likes_7d, computedAt: r.computed_at,
    }));
  }

  // ---------- audit ----------

  insertAudit(input: AuditInput): void {
    this.db.prepare(
      `INSERT INTO admin_audit (id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(newId('au'), input.action, input.targetType, input.targetId, input.detail, input.createdAt);
  }

  listAudit(limit: number): AuditRow[] {
    return (
      this.db.prepare(`SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]
    ).map((r) => ({
      id: r.id, action: r.action, targetType: r.target_type,
      targetId: r.target_id, detail: r.detail, createdAt: r.created_at,
    }));
  }
}
