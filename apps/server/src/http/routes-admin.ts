import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAdmin } from './auth.js';

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
    agentGateway?.forceDisconnect(id);
    audit('disconnect_agent', 'agent', id, {});
    return await reply.code(204).send();
  });

  app.get('/api/admin/rooms', guard, async () => ({ rows: storage.listRooms() }));

  app.post('/api/admin/rooms/:id/pause', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.pauseRoom(id);
    audit('pause_room', 'room', id, {});
    return await reply.code(204).send();
  });

  app.post('/api/admin/rooms/:id/resume', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.resumeRoom(id);
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
    storage.updateRoom(id, { status: 'archived' }); // 规格 11：房间软删除 = 归档
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
    }).parse(req.body);
    const room = engine.updateRoomSettings(id, body);
    audit('update_room', 'room', id, body);
    return room;
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
    const rows = q.roomId
      ? storage.listMessages(q.roomId, { limit: q.limit ?? 100 })
      : [];
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
