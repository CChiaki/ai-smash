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
});

describe('buildApp', () => {
  it('GET /healthz 返回 ok', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
