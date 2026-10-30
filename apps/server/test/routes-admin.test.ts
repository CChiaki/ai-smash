import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { newKey, sha256 } from '../src/ids.js';
import { composeServer } from '../src/compose.js';
import { admin, testConfig } from './http-helpers.js';

const servers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function start() {
  const handle = composeServer(testConfig());
  await handle.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (handle.app.server.address() as any).port;
  servers.push({ close: () => handle.app.close() });
  return { handle, port };
}

describe('admin routes', () => {
  it('无 token 401', async () => {
    const { handle } = await start();
    const res = await handle.app.inject({ method: 'GET', url: '/api/admin/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('overview 数字正确', async () => {
    const { handle } = await start();
    handle.storage.createKey({ id: 'key_1', hash: sha256(newKey()), label: null, createdAt: 't' });
    const res = await handle.app.inject({ method: 'GET', url: '/api/admin/overview', headers: admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json().keys).toBe(1);
    expect(res.json().activeRooms).toBeGreaterThanOrEqual(1);
  });

  it('封 key 会强制断开其 agent 并记审计', async () => {
    const { handle, port } = await start();
    const raw = newKey();
    handle.storage.createKey({ id: 'key_v', hash: sha256(raw), label: null, createdAt: 't' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/agent`);
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, key: raw, agent: { name: '小豆' } }));
    await new Promise((r) => setTimeout(r, 50));
    const agentId = handle.storage.listAgents()[0].id;
    const res = await handle.app.inject({ method: 'POST', url: '/api/admin/keys/key_v/ban', headers: admin() });
    expect(res.statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.agentGateway.onlineCount()).toBe(0);
    expect(handle.storage.getAgent(agentId)?.status).toBe('offline');
    const audit = handle.app.inject ? await handle.app.inject({ method: 'GET', url: '/api/admin/audit', headers: admin() }) : null;
    expect((audit as any).json().rows.some((r: any) => r.action === 'ban_key')).toBe(true);
    ws.terminate();
  });

  it('PATCH 房间走 updateRoomSettings：提高上限转正候补', async () => {
    const { handle } = await start();
    handle.storage.updateRoom('lobby', { maxAgents: 1 });
    handle.storage.upsertAgent({ id: 'ag_w', keyId: 'key_x', name: '候补', at: 't' });
    handle.storage.addRoomAgent('lobby', 'ag_w', 'waiting', 't1');
    const res = await handle.app.inject({ method: 'PATCH', url: '/api/admin/rooms/lobby', headers: admin(), payload: { maxAgents: 5 } });
    expect(res.statusCode).toBe(200);
    expect(handle.storage.getRoomAgent('lobby', 'ag_w')?.status).toBe('active');
  });

  it('大厅不可归档/删除（400 lobby_immutable）', async () => {
    const { handle } = await start();
    const archive = await handle.app.inject({ method: 'POST', url: '/api/admin/rooms/lobby/archive', headers: admin() });
    expect(archive.statusCode).toBe(400);
    expect(archive.json().error).toBe('lobby_immutable');
    const del = await handle.app.inject({ method: 'DELETE', url: '/api/admin/rooms/lobby', headers: admin() });
    expect(del.statusCode).toBe(400);
  });

  it('消息跨房检索：不带 roomId=全部房间（新→旧），带 roomId=单房间', async () => {
    const { handle } = await start();
    handle.storage.createRoom({
      id: 'rm_2', title: '深夜哲学', topic: null, visibility: 'public',
      ownerKeyId: 'key_1', inviteCode: null, cooldownMs: 2000, maxAgents: 20, at: 't1',
    });
    handle.storage.insertMessage({ roomId: 'lobby', senderKind: 'human', senderName: '阿伟', agentId: null, keyId: null, text: '大厅消息', replyTo: null, createdAt: '2026-10-29T10:00:00Z' });
    handle.storage.insertMessage({ roomId: 'rm_2', senderKind: 'agent', senderName: '小豆', agentId: 'ag_1', keyId: null, text: '别房消息', replyTo: null, createdAt: '2026-10-29T11:00:00Z' });
    const all = await handle.app.inject({ method: 'GET', url: '/api/admin/messages', headers: admin() });
    expect(all.statusCode).toBe(200);
    const texts = all.json().rows.map((r: any) => r.text);
    expect(texts).toContain('大厅消息');
    expect(texts).toContain('别房消息');
    expect(texts[0]).toBe('别房消息'); // 新→旧
    const one = await handle.app.inject({ method: 'GET', url: '/api/admin/messages?roomId=rm_2', headers: admin() });
    expect(one.json().rows.map((r: any) => r.text)).toEqual(['别房消息']);
  });

  it('管理员代建支持自定义 ID：重复 409、lobby 保留字 400、非法格式 400', async () => {
    const { handle } = await start();
    const custom = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { id: 'debate-night', title: '辩论之夜', speakMode: 'race', cooldownMs: 5000, maxAgents: 10 },
    });
    expect(custom.statusCode).toBe(201);
    expect(custom.json().id).toBe('debate-night');
    expect(custom.json().speakMode).toBe('race');

    const dup = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { id: 'debate-night', title: '重复的' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('room_exists');

    const lobby = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { id: 'lobby', title: '抢大厅' },
    });
    expect(lobby.statusCode).toBe(400);
    expect(lobby.json().error).toBe('lobby_immutable');

    const bad = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { id: '非法 id!', title: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('管理员代建房间：公开/私有（含邀请码），创建入列可归档', async () => {
    const { handle } = await start();
    const pub = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { title: '深夜哲学', topic: '意识是什么' },
    });
    expect(pub.statusCode).toBe(201);
    const pubRoom = pub.json();
    expect(pubRoom.id).toMatch(/^rm_/);
    expect(pubRoom.visibility).toBe('public');
    expect(pubRoom.inviteCode).toBeNull();

    const priv = await handle.app.inject({
      method: 'POST', url: '/api/admin/rooms', headers: admin(),
      payload: { title: '私密局', visibility: 'private' },
    });
    expect(priv.statusCode).toBe(201);
    expect(priv.json().inviteCode).toBeTruthy();

    const list = await handle.app.inject({ method: 'GET', url: '/api/admin/rooms', headers: admin() });
    expect(list.json().rows.map((r: any) => r.id)).toContain(pubRoom.id);

    const del = await handle.app.inject({ method: 'DELETE', url: `/api/admin/rooms/${pubRoom.id}`, headers: admin() });
    expect(del.statusCode).toBe(204);
    expect(handle.storage.getRoom(pubRoom.id)?.status).toBe('archived');
    // 审计入账：create_room 与 delete_room
    const audit = await handle.app.inject({ method: 'GET', url: '/api/admin/audit?limit=50', headers: admin() });
    const actions = audit.json().rows.map((r: any) => r.action);
    expect(actions).toContain('create_room');
    expect(actions).toContain('delete_room');
  });

  it('软删消息与事件查询', async () => {
    const { handle } = await start();
    const msg = handle.storage.insertMessage({
      roomId: 'lobby', senderKind: 'human', senderName: 'x',
      agentId: null, keyId: null, text: '违规', replyTo: null, createdAt: 't',
    });
    handle.storage.insertEvent({ id: 'ev_x', roomId: 'lobby', agentId: 'ag_x', triggerMessageId: msg.id, notifiedAt: 't' });
    const del = await handle.app.inject({ method: 'DELETE', url: `/api/admin/messages/${msg.id}`, headers: admin() });
    expect(del.statusCode).toBe(204);
    expect(handle.storage.getMessage(msg.id)?.deletedAt).toBeTruthy();
    const ev = await handle.app.inject({ method: 'GET', url: '/api/admin/events?agentId=ag_x', headers: admin() });
    expect(ev.json().rows.map((r: any) => r.id)).toEqual(['ev_x']);
  });
});
