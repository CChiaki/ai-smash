import { Topics } from '../src/topics.js';
import { describe, expect, it } from 'vitest';
import { bearer, createKeyRaw, makeApp } from './http-helpers.js';

async function setupAgentMessage() {
  const w = makeApp();
  const raw = await createKeyRaw(w.app);
  const keyId = w.storage.listKeys()[0].id;
  const agent = w.storage.upsertAgent({ keyId, name: '小豆', at: 't' });
  w.storage.setAgentStatus(agent.id, 'online', 't');
  w.storage.addRoomAgent('lobby', agent.id, 'active', 't');
  const msg = w.storage.insertMessage({
    roomId: 'lobby', senderKind: 'agent', senderName: '小豆',
    agentId: agent.id, keyId, text: '我说', replyTo: null, createdAt: new Date().toISOString(),
  });
  return { w, raw, keyId, agent, msg };
}

describe('POST /api/rooms/:id/messages', () => {
  it('持 key 发言 201，匿名 401', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const ok = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '我来投喂' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().sender.kind).toBe('human');
    expect(ok.json().sender.name).toBe('user-' + w.storage.listKeys()[0].id.slice(-4));
    expect((await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', payload: { text: 'x' } })).statusCode).toBe(401);
  });
  it('空文本 400', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const res = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '' } });
    expect(res.statusCode).toBe(400);
  });
  it('纯空白文本 400 invalid（不落库，避免空泡污染上下文）', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const res = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid');
    expect(w.storage.listMessages('lobby').filter((m) => m.senderKind === 'human')).toHaveLength(0);
  });
  it('多行 / emoji / 4000 字边界均 201（合法追问不误拒）', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    expect((await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '第一行\n第二行' } })).statusCode).toBe(201);
    expect((await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '🎉🔥👍' } })).statusCode).toBe(201);
    expect((await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: 'y'.repeat(4000) } })).statusCode).toBe(201);
  });
});

describe('POST /api/messages/:id/reactions', () => {
  it('点赞成功、重复幂等、bus 广播', async () => {
    const { w, msg } = await setupAgentMessage();
    const other = await createKeyRaw(w.app);
    const reactions: any[] = [];
    w.bus.on(Topics.reaction, (p: any) => reactions.push(p));
    const r1 = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(other) });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ likes: 1, added: true });
    const r2 = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(other) });
    expect(r2.json()).toEqual({ likes: 1, added: false });
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ roomId: 'lobby', messageId: msg.id, likes: 1 });
  });
  it('不能给自己 key 名下 agent 的消息点赞', async () => {
    const { w, raw, msg } = await setupAgentMessage();
    const other = await createKeyRaw(w.app);
    const res = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(other) });
    expect(res.statusCode).toBe(200);
    const self = await w.app.inject({ method: 'POST', url: `/api/messages/${msg.id}/reactions`, headers: bearer(raw) });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('self_like');
  });
  it('人类消息不可点赞 400', async () => {
    const { w, raw } = await setupAgentMessage();
    w.storage.ensureLobby({ title: '大厅', maxAgents: 50, at: 't' });
    const humanMsg = await w.app.inject({ method: 'POST', url: '/api/rooms/lobby/messages', headers: bearer(raw), payload: { text: '人的话' } });
    const res = await w.app.inject({ method: 'POST', url: `/api/messages/${humanMsg.json().id}/reactions`, headers: bearer(raw) });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/leaderboard', () => {
  it('返回带名字的榜单且不含 scoring 档', async () => {
    const { w, agent } = await setupAgentMessage();
    w.storage.upsertScore({ agentId: agent.id, behavior: 80, heat: 20, total: 62, tier: 'star', likes7d: 1, computedAt: 't' });
    const res = await w.app.inject({ method: 'GET', url: '/api/leaderboard' });
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ agentId: agent.id, name: '小豆', total: 62, tier: 'star' });
  });
});
