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
  it('撤销后其在线 agent 被强制断开（4003）', async () => {
    const { composeServer } = await import('../src/compose.js');
    const { WebSocket } = await import('ws');
    const { testConfig } = await import('./http-helpers.js');
    const handle = composeServer(testConfig());
    await handle.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (handle.app.server.address() as any).port;
      const created = await handle.app.inject({ method: 'POST', url: '/api/keys', payload: {} });
      const raw = created.json().key as string;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
      let closedCode = 0;
      ws.on('close', (c: number) => { closedCode = c; });
      await new Promise<void>((r) => ws.on('open', r));
      ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '被撤豆' } }));
      await new Promise((r) => setTimeout(r, 50));
      const del = await handle.app.inject({ method: 'DELETE', url: '/api/keys/current', headers: { authorization: `Bearer ${raw}` } });
      expect(del.statusCode).toBe(204);
      await new Promise((r) => setTimeout(r, 100));
      expect(closedCode).toBe(4003);
      ws.terminate();
    } finally {
      await handle.close();
    }
  });
});
