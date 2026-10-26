// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearToken, createKey, setToken } from '../src/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api()', () => {
  it('GET 携带 Bearer；POST 序列化 body', async () => {
    setToken('sk_tok');
    const f = stubFetch(200, { ok: true });
    await api('/me', { auth: true });
    await api('/rooms/lobby/messages', { body: { text: 'hi' }, auth: true });
    const [get, post] = f.mock.calls as any[];
    expect(get[0]).toBe('/api/me');
    expect((get[1] as any).headers.authorization).toBe('Bearer sk_tok');
    expect(post[0]).toBe('/api/rooms/lobby/messages');
    expect((post[1] as any).method).toBe('POST');
    expect((post[1] as any).body).toBe(JSON.stringify({ text: 'hi' }));
    clearToken();
  });

  it('401/403 归一为 ApiError', async () => {
    stubFetch(403, { error: 'banned' });
    await expect(api('/me', { auth: true })).rejects.toMatchObject({
      constructor: ApiError, status: 403, code: 'banned',
    });
  });

  it('非 JSON 错误响应兜底 unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(api('/x')).rejects.toMatchObject({ status: 500, code: 'unknown' });
  });

  it('204 → undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(api('/rooms/1/join', { body: { inviteCode: 'c' } })).resolves.toBeUndefined();
  });
});

describe('createKey', () => {
  it('返回 key 并存入 localStorage', async () => {
    stubFetch(201, { key: 'sk_new', id: 'key_1', label: null });
    const k = await createKey();
    expect(k.key).toBe('sk_new');
    expect(localStorage.getItem('ai-smash-key')).toBe('sk_new');
  });
});
