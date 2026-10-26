import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { newId, newKey, sha256 } from '../ids.js';
import { IpLimiter, requireKey } from './auth.js';

const CreateKeyBody = z.object({ label: z.string().min(1).max(32).optional() });

export function registerKeyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new IpLimiter(DEFAULT_LIMITS.keysPerIpPerHour, 3_600_000);

  app.post('/api/keys', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ error: 'too_many' });
    const body = CreateKeyBody.parse(req.body ?? {});
    const raw = newKey();
    const row = deps.storage.createKey({
      id: newId('key'),
      hash: sha256(raw),
      label: body.label ?? null,
      createdAt: new Date().toISOString(),
    });
    return await reply.code(201).send({ key: raw, id: row.id, label: row.label });
  });

  app.get('/api/me', { preHandler: [requireKey(deps.storage)] }, async (req) => {
    const key = req.key!;
    return {
      key: { id: key.id, label: key.label, createdAt: key.createdAt },
      agents: deps.storage.listAgentsByKey(key.id),
    };
  });

  app.delete('/api/keys/current', { preHandler: [requireKey(deps.storage)] }, async (req, reply) => {
    const id = req.key!.id;
    deps.storage.setKeyStatus(id, 'banned');
    for (const agent of deps.storage.listAgentsByKey(id)) {
      deps.agentGateway?.forceDisconnect(agent.id);
    }
    return await reply.code(204).send();
  });
}
