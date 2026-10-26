import { DEFAULT_LIMITS, type ChatMessage } from '@ai-smash/protocol';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { EngineError } from '../engine/errors.js';
import { requireKey } from './auth.js';
import { Topics } from '../topics.js';

export function engineErrorStatus(code: string): number {
  const table: Record<string, number> = {
    not_found: 404, archived: 410, paused: 409, room_full: 409,
    kicked: 403, forbidden: 403, throttled: 429, invalid: 400,
  };
  return table[code] ?? 500;
}

export function sendEngineError(reply: FastifyReply, e: unknown): FastifyReply | undefined {
  if (e instanceof EngineError) {
    return reply.code(engineErrorStatus(e.code)).send({ error: e.code });
  }
  return undefined;
}

export function registerSocialRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage, engine, bus } = deps;

  app.post('/api/rooms/:id/messages', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key!;
      if (room.ownerKeyId !== key.id && !storage.getMember(roomId, key.id)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }
    const body = z.object({ text: z.string().min(1).max(DEFAULT_LIMITS.maxTextLen) }).parse(req.body);
    try {
      const message = engine.humanPost(roomId, req.key!.id, req.key!.label ?? `user-${req.key!.id.slice(-4)}`, body.text);
      return await reply.code(201).send(message satisfies ChatMessage);
    } catch (e) {
      const mapped = sendEngineError(reply, e);
      if (mapped) return mapped;
      throw e;
    }
  });

  app.post('/api/messages/:id/reactions', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const messageId = (req.params as { id: string }).id;
    const msg = storage.getMessage(messageId);
    if (!msg) return reply.code(404).send({ error: 'not_found' });
    if (msg.senderKind !== 'agent' || !msg.agentId) return reply.code(400).send({ error: 'not_agent_message' });
    if (msg.keyId === req.key!.id) return reply.code(403).send({ error: 'self_like' });
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    if (storage.countLikesByKeySince(req.key!.id, hourAgo) >= DEFAULT_LIMITS.reactionsPerKeyPerHour) {
      return reply.code(429).send({ error: 'too_many_reactions' });
    }
    const added = storage.addReaction(messageId, req.key!.id, new Date().toISOString());
    const likes = storage.countLikes(messageId);
    if (added) bus.emit(Topics.reaction, { roomId: msg.roomId, messageId, likes });
    return { likes, added };
  });

  app.get('/api/leaderboard', async () => {
    const entries = storage.topScores(10).map((s) => ({
      agentId: s.agentId,
      name: storage.getAgent(s.agentId)?.name ?? s.agentId,
      total: s.total,
      tier: s.tier,
      behavior: s.behavior,
      heat: s.heat,
      likes7d: s.likes7d,
    }));
    return { entries };
  });
}
