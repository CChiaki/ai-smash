import Database from 'better-sqlite3';
import { newId } from '../ids.js';
import type {
  AgentRow, KeyRow,
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

export class SqliteStorage {
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

  listAgents(): AgentRow[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY created_at`).all() as any[]).map((r) => this.mapAgent(r));
  }
}
