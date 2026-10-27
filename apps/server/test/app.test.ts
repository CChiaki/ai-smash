import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { makeApp } from './http-helpers.js';

describe('loadConfig', () => {
  it('缺 ADMIN_TOKEN 报错', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });
  it('默认端口 8787，token 透传', () => {
    const c = loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
    expect(c.port).toBe(8787);
    expect(c.adminToken).toBe('test-admin-token');
    expect(c.dbPath).toBe(':memory:');
  });
  it('trustProxy 默认 false', () => {
    const c = loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
    expect(c.trustProxy).toBe(false);
  });
  it("TRUST_PROXY: 'true' 解析为 true", () => {
    const c = loadConfig({
      ADMIN_TOKEN: 'test-admin-token',
      DB_PATH: ':memory:',
      TRUST_PROXY: 'true',
    } as NodeJS.ProcessEnv);
    expect(c.trustProxy).toBe(true);
  });
});

describe('buildApp', () => {
  it('GET /healthz 返回 ok', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /healthz 带 CSP 响应头', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(String(csp)).toContain("default-src 'self'");
  });

  it('trustProxy 开启时 req.ip 取 X-Forwarded-For', async () => {
    const config = loadConfig({
      ADMIN_TOKEN: 'test-admin-token',
      DB_PATH: ':memory:',
      TRUST_PROXY: 'true',
    } as NodeJS.ProcessEnv);
    const { buildApp } = await import('../src/app.js');
    const { MemoryBus, RoomEngine, SqliteStorage } = await import('../src/index.js');
    const storage = new SqliteStorage(':memory:');
    const app = buildApp({
      storage,
      bus: new MemoryBus(),
      engine: new RoomEngine({ storage, bus: new MemoryBus() }),
      config,
    });
    app.get('/whoami-ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami-ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    expect(res.json().ip).toBe('203.0.113.9');
  });
});
