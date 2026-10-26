import { describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { IpLimiter, humanName, requireKey, requireAdmin } from '../src/http/auth.js';
import { makeApp } from './http-helpers.js';

describe('IpLimiter', () => {
  it('窗口内限量、放行后拒绝', () => {
    const l = new IpLimiter(2, 60_000);
    expect(l.allow('ip1')).toBe(true);
    expect(l.allow('ip1')).toBe(true);
    expect(l.allow('ip1')).toBe(false);
    expect(l.allow('ip2')).toBe(true);
  });
});

describe('humanName', () => {
  it('有 label 用 label，否则 user-后缀', () => {
    expect(humanName({ id: 'key_abcdef', hash: '', label: '阿伟', status: 'active', createdAt: '', lastSeenAt: null, notes: null })).toBe('阿伟');
    expect(humanName({ id: 'key_abcdef', hash: '', label: null, status: 'active', createdAt: '', lastSeenAt: null, notes: null })).toBe('user-cdef');
  });
});

describe('requireKey / requireAdmin（经真实路由验证）', () => {
  it('无 token 401；坏 key 401；好 key 200', async () => {
    const { app, storage } = makeApp();
    app.get('/who', { preHandler: requireKey(storage) }, async (req) => ({ id: (req as any).key.id }));
    expect((await app.inject({ method: 'GET', url: '/who' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/who', headers: { authorization: 'Bearer sk_bad' } })).statusCode).toBe(401);
    const raw = newKey();
    storage.createKey({ id: 'key_t1', hash: sha256(raw), label: null, createdAt: 't' });
    const res = await app.inject({ method: 'GET', url: '/who', headers: { authorization: `Bearer ${raw}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('key_t1');
  });
  it('封禁 key 403', async () => {
    const { app, storage } = makeApp();
    app.get('/who', { preHandler: requireKey(storage) }, async () => ({}));
    const raw = newKey();
    storage.createKey({ id: 'key_t2', hash: sha256(raw), label: null, createdAt: 't' });
    storage.setKeyStatus('key_t2', 'banned');
    expect((await app.inject({ method: 'GET', url: '/who', headers: { authorization: `Bearer ${raw}` } })).statusCode).toBe(403);
  });
  it('管理员 token 不符 401', async () => {
    const { app, config } = makeApp();
    app.get('/adm', { preHandler: requireAdmin(config) }, async () => ({}));
    expect((await app.inject({ method: 'GET', url: '/adm' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/adm', headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/adm', headers: { 'x-admin-token': 'test-admin-token' } })).statusCode).toBe(200);
  });
});