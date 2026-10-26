import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/ids.js';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

describe('POST /api/keys', () => {
  it('创建成功，明文只出现一次', async () => {
    const { app, storage } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: { label: '阿伟' } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key.startsWith('sk_')).toBe(true);
    expect(body.label).toBe('阿伟');
    expect(storage.getKeyByHash(sha256(body.key))?.id).toBe(body.id);
  });
  it('同 IP 超过 10 次/小时 → 429', async () => {
    const { app } = makeApp();
    for (let i = 0; i < DEFAULT_LIMITS.keysPerIpPerHour; i++) {
      expect((await app.inject({ method: 'POST', url: '/api/keys', payload: {} })).statusCode).toBe(201);
    }
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: {} });
    expect(res.statusCode).toBe(429);
  });
  it('label 超长 400', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/keys', payload: { label: 'x'.repeat(33) } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/me', () => {
  it('返回 key 信息与名下 agents', async () => {
    const { app, storage } = makeApp();
    const raw = await createKeyRaw(app);
    storage.upsertAgent({ keyId: storage.listKeys()[0].id, name: '小豆', at: 't' });
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(raw) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key.label).toBeNull();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('小豆');
  });
  it('匿名 401', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });
});

describe('DELETE /api/keys/current', () => {
  it('撤销后原 key 403', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const del = await app.inject({ method: 'DELETE', url: '/api/keys/current', headers: bearer(raw) });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: bearer(raw) })).statusCode).toBe(403);
  });
});
