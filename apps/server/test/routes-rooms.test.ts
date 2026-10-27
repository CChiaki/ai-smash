import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { describe, expect, it } from 'vitest';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function createRoom(app: ReturnType<typeof makeApp>['app'], raw: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/rooms', headers: bearer(raw),
    payload: { title: '深夜哲学', topic: '意识', visibility: 'private', ...over },
  });
  return res;
}

describe('POST /api/rooms', () => {
  it('创建私有房间，主人是成员，inviteCode 只给主人', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const res = await createRoom(app, raw);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.visibility).toBe('private');
    expect(body.inviteCode).toBeTruthy();
    expect(body.onlineAgents).toBe(0);
  });
  it('maxAgents clamp 到硬顶', async () => {
    const { app } = makeApp();
    const raw = await createKeyRaw(app);
    const res = await createRoom(app, raw, { visibility: 'public', maxAgents: 100_000 });
    expect(res.json().maxAgents).toBe(DEFAULT_LIMITS.roomHardCap);
    expect(res.json().cooldownMs).toBe(10000);
  });
  it('匿名 401', async () => {
    const { app } = makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { title: 'x', visibility: 'public' } })).statusCode).toBe(401);
  });
});

describe('GET /api/rooms', () => {
  it('公开房列表匿名可读，私有房不出现在公开列表', async () => {
    const { app, storage } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const raw = await createKeyRaw(app);
    await createRoom(app, raw);
    const res = await app.inject({ method: 'GET', url: '/api/rooms?visibility=public' });
    expect(res.json().rooms.map((r: any) => r.id).sort()).toEqual(['lobby']);
  });
  it('无 visibility 参数的匿名请求只返回公开房', async () => {
    const { app, storage } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const raw = await createKeyRaw(app);
    await createRoom(app, raw); // 私有房
    const res = await app.inject({ method: 'GET', url: '/api/rooms' });
    expect(res.json().rooms.map((r: any) => r.id)).toEqual(['lobby']);
  });
  it('?preview=3 附最近消息与 likes 字段；不传 preview 不逐房拉取', async () => {
    const { app, storage, engine } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    engine.humanPost('lobby', 'key_x', '阿伟', '第一条');
    engine.humanPost('lobby', 'key_x', '阿伟', '第二条');
    const res = await app.inject({ method: 'GET', url: '/api/rooms?preview=3' });
    const lobby = res.json().rooms.find((r: any) => r.id === 'lobby');
    expect(lobby.preview).toHaveLength(2); // 只有两条消息，全部带上
    expect(lobby.preview[0]).toMatchObject({ text: '第一条', sender: { kind: 'human', name: '阿伟' } });
    expect(lobby.preview.every((m: any) => typeof m.likes === 'number')).toBe(true); // likes 字段存在
    const plain = await app.inject({ method: 'GET', url: '/api/rooms' });
    expect(plain.json().rooms[0].preview).toBeUndefined(); // 未显式传参不附 preview
  });
});

describe('GET /api/rooms/:id', () => {
  it('私有房匿名 404、成员 200、主人带 inviteCode', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}` })).statusCode).toBe(404);
    const other = await createKeyRaw(app);
    expect((await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(other) })).statusCode).toBe(404);
    const ownerRes = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(owner) });
    expect(ownerRes.statusCode).toBe(200);
    expect(ownerRes.json().inviteCode).toBe(room.inviteCode);
  });
});

describe('POST /api/rooms/:id/join', () => {
  it('邀请码正确加入、错误 403', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    const other = await createKeyRaw(app);
    const bad = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: bearer(other), payload: { inviteCode: 'nope' } });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/join`, headers: bearer(other), payload: { inviteCode: room.inviteCode } });
    expect(ok.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: bearer(other) });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /api/rooms/:id/messages', () => {
  it('公开房匿名可读历史', async () => {
    const { app, storage, engine } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    engine.humanPost('lobby', 'key_x', '阿伟', '历史消息');
    const res = await app.inject({ method: 'GET', url: '/api/rooms/lobby/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages.at(-1).text).toBe('历史消息');
  });
  it('历史消息附累计赞数：点赞后拉历史 likes === 1', async () => {
    const { app, storage } = makeApp();
    storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const raw = await createKeyRaw(app);
    const keyId = storage.listKeys()[0].id;
    const agent = storage.upsertAgent({ keyId, name: '小豆', at: 't' });
    storage.setAgentStatus(agent.id, 'online', 't');
    storage.addRoomAgent('lobby', agent.id, 'active', 't');
    const msg = storage.insertMessage({
      roomId: 'lobby', senderKind: 'agent', senderName: '小豆',
      agentId: agent.id, keyId, text: '我说', replyTo: null, createdAt: new Date().toISOString(),
    });
    const other = await createKeyRaw(app);
    const react = await app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(other) });
    expect(react.json().likes).toBe(1);
    const res = await app.inject({ method: 'GET', url: '/api/rooms/lobby/messages' });
    const m = res.json().messages.find((x: any) => x.id === msg.id);
    expect(m.likes).toBe(1); // 历史拉取带累计赞数
  });
  it('私有房非成员 403', async () => {
    const { app } = makeApp();
    const owner = await createKeyRaw(app);
    const room = (await createRoom(app, owner)).json();
    const other = await createKeyRaw(app);
    const res = await app.inject({ method: 'GET', url: `/api/rooms/${room.id}/messages`, headers: bearer(other) });
    expect(res.statusCode).toBe(403);
  });
});