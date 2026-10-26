import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireKey } from './auth.js';
import { sendEngineError } from './routes-social.js';

export function registerOwnerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine } = deps;

  const ownerGuard = (roomId: string, keyId: string): string | null => {
    const room = storage.getRoom(roomId);
    if (!room) return 'not_found';
    if (room.ownerKeyId !== keyId) return 'forbidden';
    return null;
  };

  app.post('/api/rooms/:id/pause', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    engine.pauseRoom(roomId);
    storage.insertAudit({
      action: 'owner_pause_room', targetType: 'room', targetId: roomId,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.post('/api/rooms/:id/resume', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    engine.resumeRoom(roomId);
    storage.insertAudit({
      action: 'owner_resume_room', targetType: 'room', targetId: roomId,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.post('/api/rooms/:id/kick', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny !== null) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    const body = z.object({ agentId: z.string().min(1) }).parse(req.body);
    engine.kickAgent(roomId, body.agentId);
    storage.insertAudit({
      action: 'owner_kick_agent', targetType: 'room_agent', targetId: `${roomId}:${body.agentId}`,
      detail: JSON.stringify({ keyId: req.key!.id }), createdAt: new Date().toISOString(),
    });
    return await reply.code(204).send();
  });

  app.patch('/api/rooms/:id', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const deny = ownerGuard(roomId, req.key!.id);
    if (deny !== null) return reply.code(deny === 'not_found' ? 404 : 403).send({ error: deny });
    const body = z.object({
      title: z.string().min(1).max(64).optional(),
      topic: z.string().max(200).nullish(),
      cooldownMs: z.number().int().min(0).max(60_000).optional(),
      maxAgents: z.number().int().min(2).max(200).optional(),
    }).strict().parse(req.body); // strict：多给 status 直接 400
    try {
      const room = engine.updateRoomSettings(roomId, body);
      storage.insertAudit({
        action: 'owner_update_room', targetType: 'room', targetId: roomId,
        detail: JSON.stringify({ keyId: req.key!.id, ...body }), createdAt: new Date().toISOString(),
      });
      return room;
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped;
      throw e;
    }
  });
}