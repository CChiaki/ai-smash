import { describe, expect, it } from 'vitest';
import { admin, bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function setup() {
  const w = makeApp();
  const owner = await createKeyRaw(w.app);
  const other = await createKeyRaw(w.app);
  const room = await w.app.inject({
    method: 'POST', url: '/api/rooms', headers: bearer(owner),
    payload: { title: '房主测试', visibility: 'public' },
  });
  const roomId = room.json().id;
  return { w, owner, other, roomId };
}

describe('owner routes', () => {
  it('非房主 403', async () => {
    const { w, other, roomId } = await setup();
    const res = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/pause`, headers: bearer(other) });
    expect(res.statusCode).toBe(403);
  });
  it('房主可暂停/恢复并写审计', async () => {
    const { w, owner, roomId } = await setup();
    const pause = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/pause`, headers: bearer(owner) });
    expect(pause.statusCode).toBe(204);
    expect(w.storage.getRoom(roomId)?.status).toBe('paused');
    const resume = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/resume`, headers: bearer(owner) });
    expect(resume.statusCode).toBe(204);
    expect(w.storage.getRoom(roomId)?.status).toBe('active');
    const audit = await w.app.inject({ method: 'GET', url: '/api/admin/audit', headers: admin() });
    expect(audit.json().rows.some((r: any) => r.action === 'owner_pause_room')).toBe(true);
  });
  it('房主可踢 agent 并改设置', async () => {
    const { w, owner, roomId } = await setup();
    const keyId = w.storage.listKeys().find((k) => k.hash !== '')!.id;
    const agent = w.storage.upsertAgent({ keyId, name: '被踢豆', at: 't' });
    w.storage.addRoomAgent(roomId, agent.id, 'active', 't');
    const kick = await w.app.inject({ method: 'POST', url: `/api/rooms/${roomId}/kick`, headers: bearer(owner), payload: { agentId: agent.id } });
    expect(kick.statusCode).toBe(204);
    expect(w.storage.getRoomAgent(roomId, agent.id)?.status).toBe('kicked');
    const patch = await w.app.inject({ method: 'PATCH', url: `/api/rooms/${roomId}`, headers: bearer(owner), payload: { cooldownMs: 5000, maxAgents: 10 } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().cooldownMs).toBe(5000);
  });
  it('PATCH status 字段被拒绝 400', async () => {
    const { w, owner, roomId } = await setup();
    const res = await w.app.inject({ method: 'PATCH', url: `/api/rooms/${roomId}`, headers: bearer(owner), payload: { status: 'archived' } });
    expect(res.statusCode).toBe(400);
  });
});
