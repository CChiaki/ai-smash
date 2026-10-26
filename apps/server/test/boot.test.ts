import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'aismash-'));
  dirs.push(dir);
  const dbPath = join(dir, 'data', 'test.db');
  mkdirSync(join(dir, 'data'), { recursive: true });
  const h = await boot({ ...testConfig(), dbPath, port: 0 });
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

  it('存在 apps/web/dist 时 SPA 回退，API 路径不回退', async () => {
    const distDir = 'apps/web/dist';
    const hadRealDist = existsSync(join(distDir, 'index.html'));
    if (!hadRealDist) {
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.html'), '<html>spa</html>');
    }
    try {
      const { h, base } = await start();
      const res = await fetch(`${base}/some/spa/route`);
      expect(await res.text()).toContain('<'); // 真实 dist 或临时 dist 都以 <html 开头
      const api = await fetch(`${base}/api/nothing`);
      expect(api.status).toBe(404);
      await h.shutdown();
    } finally {
      if (!hadRealDist) rmSync(distDir, { recursive: true, force: true });
    }
  });
});
