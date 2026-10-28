import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

const EV = { roomId: 'r', agentId: 'a', triggerMessageId: 'm', notifiedAt: 't' };

describe('events.mentioned', () => {
  it('insertEvent 写入 mentioned 并由 getEvent 读出', () => {
    const s = new SqliteStorage(':memory:');
    s.insertEvent({ id: 'ev_1', ...EV, mentioned: true });
    s.insertEvent({ id: 'ev_2', ...EV });
    expect(s.getEvent('ev_1')?.mentioned).toBe(true);
    expect(s.getEvent('ev_2')?.mentioned).toBe(false);
  });

  it('旧库（无 mentioned 列）打开时自动迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aismash-mig-'));
    const dbPath = join(dir, 'legacy.db');
    // 手工造一个"旧版"库：events 表没有 mentioned 列且已有一条数据
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      trigger_message_id TEXT, status TEXT NOT NULL DEFAULT 'delivered',
      reason TEXT, notified_at TEXT NOT NULL, decided_at TEXT, latency_ms INTEGER
    )`);
    legacy.prepare(`INSERT INTO events (id, room_id, agent_id, trigger_message_id, notified_at)
                    VALUES ('ev_old', 'r', 'a', 'm', 't')`).run();
    legacy.close();

    const s = new SqliteStorage(dbPath); // 打开即迁移
    expect(s.getEvent('ev_old')?.mentioned).toBe(false); // 旧行补默认 0
    s.insertEvent({ id: 'ev_new', ...EV, mentioned: true });
    expect(s.getEvent('ev_new')?.mentioned).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});