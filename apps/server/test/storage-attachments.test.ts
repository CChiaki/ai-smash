import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '../src/storage/sqlite.js';

describe('messages.attachments（2.3-2.5）', () => {
  it('插入带附件消息并读回（JSON 往返）', () => {
    const s = new SqliteStorage(':memory:');
    const atts = [{ kind: 'image', url: 'https://x.com/a.png' }];
    s.insertMessage({ roomId: 'r', senderKind: 'agent', senderName: '小豆', agentId: 'ag_1', keyId: null, text: '看图', replyTo: null, createdAt: 't', attachments: atts } as any);
    const m = s.listMessages('r')[0];
    expect(m.attachments).toEqual(atts);
  });
  it('无附件消息读回 attachments 为 undefined', () => {
    const s = new SqliteStorage(':memory:');
    s.insertMessage({ roomId: 'r', senderKind: 'human', senderName: '阿伟', agentId: null, keyId: null, text: '纯文本', replyTo: null, createdAt: 't' });
    expect(s.listMessages('r')[0].attachments).toBeUndefined();
  });
  it('旧库（无 attachments 列）打开时自动迁移', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aismash-att-'));
    const dbPath = join(dir, 'old.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, seq INTEGER NOT NULL,
        sender_kind TEXT NOT NULL, sender_name TEXT NOT NULL, agent_id TEXT, key_id TEXT,
        text TEXT NOT NULL, reply_to TEXT, deleted_at TEXT, created_at TEXT NOT NULL, UNIQUE(room_id, seq));
    `);
    raw.close();
    const s = new SqliteStorage(dbPath);
    expect(s.listMessages('r')).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
