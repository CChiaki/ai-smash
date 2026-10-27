import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { boot } from '../src/server.js';
import { testConfig } from './http-helpers.js';

// boot() 内部 loadConfig() 从进程环境读取必需变量；测试环境补齐（不改动 brief 源码）
process.env.ADMIN_TOKEN ??= 'test-admin-token';

const dirs: string[] = [];
afterAll(async () => {
  for (const h of booted) await h.shutdown();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const booted: Array<{ shutdown: () => Promise<void> }> = [];

async function start(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aismash-'));
  dirs.push(dir);
  const dbPath = join(dir, 'data', 'test.db');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const h = await boot({ ...testConfig(), dbPath, port: 0, ...over });
  booted.push(h);
  const port = (h.app.server.address() as any).port;
  return { h, base: `http://127.0.0.1:${port}` };
}

describe('boot（server.ts 组装）', () => {
  it('启动即有大厅；重启恢复把未决事件记 timeout', async () => {
    const first = await start();
    const raw = newKey();
    first.h.storage.createKey({ id: 'key_r', hash: sha256(raw), label: null, createdAt: 't' });
    first.h.storage.upsertAgent({ id: 'ag_r', keyId: 'key_r', name: '小豆', at: 't' });
    first.h.storage.insertEvent({ id: 'ev_pending', roomId: 'lobby', agentId: 'ag_r', triggerMessageId: 'm', notifiedAt: 't' });
    await first.h.shutdown();

    const second = await boot({ ...testConfig(), dbPath: join(dirs[0], 'data', 'test.db'), port: 0 });
    booted.push(second);
    expect(second.storage.getRoom('lobby')).toBeTruthy();
    expect(second.storage.getEvent('ev_pending')?.status).toBe('timeout');
  });

  it('配置 corsOrigin 后 API 带跨源头，OPTIONS 预检 204；未配置则不带', async () => {
    const { h, base } = await start({ corsOrigin: 'https://web.example' });
    const res = await fetch(`${base}/api/rooms?visibility=public`, { headers: { origin: 'https://web.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://web.example');
    const pre = await fetch(`${base}/api/rooms`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-admin-token');
    await h.shutdown();

    const plain = await start();
    const res2 = await fetch(`${plain.base}/api/rooms?visibility=public`);
    expect(res2.headers.get('access-control-allow-origin')).toBeNull();
    await plain.h.shutdown();
  });
});
