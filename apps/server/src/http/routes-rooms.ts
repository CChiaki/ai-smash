import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { newId, newInviteCode } from '../ids.js';
import { toChatMessage } from '../engine/chat.js';
import { requireKey } from './auth.js';
import { roomSummary } from './room-summary.js';

const CreateRoomBody = z.object({
  title: z.string().min(1).max(64),
  topic: z.string().max(200).nullish(),
  visibility: z.enum(['public', 'private']),
  maxAgents: z.number().int().min(2).optional(),
  cooldownMs: z.number().int().min(0).max(DEFAULT_LIMITS.maxDeadlineMs).optional(),
});

export function registerRoomRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { storage } = deps;

  app.post('/api/rooms', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const body = CreateRoomBody.parse(req.body);
    const maxAgents = Math.min(body.maxAgents ?? DEFAULT_LIMITS.roomMaxAgents, DEFAULT_LIMITS.roomHardCap);
    const room = storage.createRoom({
      id: newId('rm'),
      title: body.title,
      topic: body.topic ?? null,
      visibility: body.visibility,
      ownerKeyId: req.key!.id,
      inviteCode: body.visibility === 'private' ? newInviteCode() : null,
      cooldownMs: body.cooldownMs ?? DEFAULT_LIMITS.cooldownMs,
      maxAgents,
      at: new Date().toISOString(),
    });
    storage.addMember(room.id, req.key!.id, 'host', new Date().toISOString());
    return await reply.code(201).send({ ...roomSummary(storage, room), inviteCode: room.inviteCode });
  });

  app.get('/api/rooms', async (req) => {
    const q = z.object({
      visibility: z.enum(['public', 'private']).optional(),
      // preview=N：每房附带最近 N 条消息（含累计赞数），仅显式传参才逐房拉取
      preview: z.coerce.number().int().min(1).max(10).optional(),
    }).parse(req.query);
    if (q.visibility === 'public' || q.visibility === undefined) {
      const rooms = storage.listRooms('public').map((r) => {
        const summary = roomSummary(storage, r);
        if (q.preview === undefined) return summary;
        return {
          ...summary,
          // 预览瘦身：base64 掏空为占位摘要（url 保留），房间列表接口不被大附件放大
          preview: storage.listMessages(r.id, { limit: q.preview })
            .map((m) => {
              const chat = toChatMessage(m);
              return {
                ...chat,
                ...(chat.attachments ? {
                  attachments: chat.attachments.map((a) =>
                    a.base64 ? { kind: a.kind, url: `[base64 附件 ×${Math.ceil(a.base64.length / 1000)}KB]` } : a),
                } : {}),
                likes: storage.countLikes(m.id),
              };
            }),
        };
      });
      return { rooms };
    }
    // private：只返回与当前 key 相关的房间
    const key = req.key;
    if (!key) return { rooms: [] };
    const rooms = storage.listRooms('private')
      .filter((r) => r.ownerKeyId === key.id || storage.getMember(r.id, key.id))
      .map((r) => roomSummary(storage, r));
    return { rooms };
  });

  app.get('/api/rooms/:id', async (req, reply) => {
    const room = storage.getRoom((req.params as { id: string }).id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key;
      const allowed = key && (room.ownerKeyId === key.id || storage.getMember(room.id, key.id));
      if (!allowed) return reply.code(404).send({ error: 'not_found' });
      return { ...roomSummary(storage, room), inviteCode: room.inviteCode };
    }
    return roomSummary(storage, room);
  });

  app.post('/api/rooms/:id/join', { preHandler: [requireKey(storage)] }, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room || room.visibility !== 'private') return reply.code(404).send({ error: 'not_found' });
    const body = z.object({ inviteCode: z.string().min(1) }).parse(req.body);
    if (room.inviteCode !== body.inviteCode) return reply.code(403).send({ error: 'bad_invite' });
    if (!storage.getMember(roomId, req.key!.id)) {
      storage.addMember(roomId, req.key!.id, 'member', new Date().toISOString());
    }
    return await reply.code(204).send();
  });

  app.get('/api/rooms/:id/messages', async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key;
      const allowed = key && (room.ownerKeyId === key.id || storage.getMember(room.id, key.id));
      if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    }
    const q = z.object({
      after: z.coerce.number().int().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);
    const rows = storage.listMessages(roomId, { afterSeq: q.after, limit: q.limit ?? 100 });
    return { messages: rows.map((row) => ({ ...toChatMessage(row), likes: storage.countLikes(row.id) })) };
  });

  // 在场 agent 列表：公开房匿名可读（首页直播预览用），私有房仅成员
  app.get('/api/rooms/:id/agents', async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    const room = storage.getRoom(roomId);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.visibility === 'private') {
      const key = req.key;
      const allowed = key && (room.ownerKeyId === key.id || storage.getMember(room.id, key.id));
      if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    }
    return { agents: deps.engine.listPresence(roomId) };
  });
}