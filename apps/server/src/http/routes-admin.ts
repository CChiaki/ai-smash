import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { AppDeps } from '../app.js';
import { newId, newInviteCode } from '../ids.js';
import { requireAdmin } from './auth.js';
import { sendEngineError } from './routes-social.js';
import { roomSummary } from './room-summary.js';

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine, agentGateway } = deps;
  const guard = { preHandler: [requireAdmin(deps.config)] };

  const audit = (action: string, targetType: string, targetId: string, detail: unknown): void => {
    storage.insertAudit({
      action, targetType, targetId,
      detail: JSON.stringify(detail ?? {}),
      createdAt: new Date().toISOString(),
    });
  };

  app.get('/api/admin/overview', guard, async () => {
    const tenMinAgo = new Date(Date.now() - 600_000).toISOString();
    return {
      keys: storage.listKeys().length,
      agentsOnline: storage.listAgents().filter((a) => a.status === 'online' || a.status === 'thinking').length,
      activeRooms: storage.listRooms().filter((r) => r.status === 'active').length,
      messages10m: storage.countMessagesSince(tenMinAgo),
      agentConnections: agentGateway?.onlineCount() ?? 0,
      humanConnections: deps.humanGateway?.onlineCount() ?? 0,
    };
  });

  app.get('/api/admin/keys', guard, async () => ({ rows: storage.listKeys() }));

  app.post('/api/admin/keys/:id/ban', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.setKeyStatus(id, 'banned');
    for (const agent of storage.listAgentsByKey(id)) {
      agentGateway?.forceDisconnect(agent.id);
    }
    audit('ban_key', 'key', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/keys/:id/unban', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.setKeyStatus(id, 'active');
    audit('unban_key', 'key', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/agents', guard, async () => ({
    rows: storage.listAgents().map((a) => ({ ...a, score: storage.getScore(a.id) ?? null })),
  }));

  app.post('/api/admin/agents/:id/disconnect', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const connected = agentGateway?.forceDisconnect(id) ?? false;
    // 审计记录真实效果：本就不在线的断开操作也如实留痕（connected=false）
    audit('disconnect_agent', 'agent', id, { connected });
    return await reply.code(200).send({ connected });
  });

  app.get('/api/admin/rooms', guard, async () => ({ rows: storage.listRooms() }));

  // 管理员代建房间：无个人 key 归属（ownerKeyId=null，同 lobby 形态）；私有房自动发邀请码；
  // 支持自定义房间 ID（保留字 lobby 不可用、重复返回 409）
  app.post('/api/admin/rooms', guard, async (req, reply) => {
    const body = z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{2,64}$/).optional(),
      title: z.string().min(1).max(64),
      topic: z.string().max(200).nullish(),
      visibility: z.enum(['public', 'private']).default('public'),
      cooldownMs: z.number().int().min(0).max(60_000).optional(),
      maxAgents: z.number().int().min(2).max(200).optional(),
      speakMode: z.enum(['roundrobin', 'race']).optional(),
    }).parse(req.body);
    if (body.id === 'lobby') return reply.code(400).send({ error: 'lobby_immutable' });
    if (body.id && storage.getRoom(body.id)) return reply.code(409).send({ error: 'room_exists' });
    const room = storage.createRoom({
      id: body.id ?? newId('rm'),
      title: body.title,
      topic: body.topic ?? null,
      visibility: body.visibility,
      ownerKeyId: null,
      inviteCode: body.visibility === 'private' ? newInviteCode() : null,
      cooldownMs: body.cooldownMs ?? DEFAULT_LIMITS.cooldownMs,
      maxAgents: Math.min(body.maxAgents ?? DEFAULT_LIMITS.roomMaxAgents, DEFAULT_LIMITS.roomHardCap),
      ...(body.speakMode ? { speakMode: body.speakMode } : {}),
      at: new Date().toISOString(),
    });
    audit('create_room', 'room', room.id, { visibility: body.visibility, speakMode: room.speakMode });
    return await reply.code(201).send({ ...roomSummary(storage, room), inviteCode: room.inviteCode });
  });

  app.post('/api/admin/rooms/:id/pause', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      engine.pauseRoom(id);
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped; // 归档/删除是终态：不可暂停
      throw e;
    }
    audit('pause_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/rooms/:id/resume', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      engine.resumeRoom(id);
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped; // 归档/删除是终态：不可恢复
      throw e;
    }
    audit('resume_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/rooms/:id/archive', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === 'lobby') return reply.code(400).send({ error: 'lobby_immutable' }); // 规格 5.3：大厅不可删除或归档
    storage.updateRoom(id, { status: 'archived' });
    audit('archive_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.delete('/api/admin/rooms/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (id === 'lobby') return reply.code(400).send({ error: 'lobby_immutable' });
    // 删除 ≠ 归档：deleted 状态在前台各列表/详情中隐藏（归档仍可见但锁定）
    storage.updateRoom(id, { status: 'deleted' });
    audit('delete_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.patch('/api/admin/rooms/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({
      title: z.string().min(1).max(64).optional(),
      topic: z.string().max(200).nullish(),
      cooldownMs: z.number().int().min(0).max(60_000).optional(),
      maxAgents: z.number().int().min(2).max(200).optional(),
      speakMode: z.enum(['roundrobin', 'race']).optional(),
    }).parse(req.body);
    try {
      const room = engine.updateRoomSettings(id, body);
      audit('update_room', 'room', id, body);
      return room;
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped;
      throw e;
    }
  });

  app.post('/api/admin/rooms/:id/kick', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ agentId: z.string().min(1) }).parse(req.body);
    engine.kickAgent(id, body.agentId);
    audit('kick_agent', 'room_agent', `${id}:${body.agentId}`, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/messages', guard, async (req) => {
    const q = z.object({
      roomId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    // 跨房检索：不给 roomId = 全部房间（新→旧）；给了 = 单房间（旧→新）
    const rows = q.roomId
      ? storage.listMessages(q.roomId, { limit: q.limit ?? 100 })
      : storage.listLatestMessages(q.limit ?? 100);
    return { rows };
  });

  app.delete('/api/admin/messages/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    storage.softDeleteMessage(id, new Date().toISOString());
    audit('delete_message', 'message', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/events', guard, async (req) => {
    const q = z.object({
      agentId: z.string().optional(),
      roomId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    return { rows: storage.listEvents(q) };
  });

  app.get('/api/admin/audit', guard, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return { rows: storage.listAudit(q.limit ?? 100) };
  });
}
