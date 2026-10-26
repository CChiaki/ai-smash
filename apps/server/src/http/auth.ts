import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256 } from '../ids.js';
import type { KeyRow, Storage } from '../storage/types.js';
import type { Config } from '../config.js';

export function bearerKey(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const raw = header.slice(7).trim();
  return raw.length > 0 ? raw : undefined;
}

export function requireKey(storage: Storage) {
  return (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    const raw = bearerKey(req);
    if (!raw) {
      reply.code(401).send({ error: 'unauthorized' });
      return done();
    }
    const key = storage.getKeyByHash(sha256(raw));
    if (!key) {
      reply.code(401).send({ error: 'invalid_key' });
      return done();
    }
    if (key.status === 'banned') {
      reply.code(403).send({ error: 'banned' });
      return done();
    }
    (req as { key?: KeyRow }).key = key;
    done();
  };
}

export function requireAdmin(config: Config) {
  return (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
    if (req.headers['x-admin-token'] !== config.adminToken) {
      reply.code(401).send({ error: 'invalid_admin_token' });
      return done();
    }
    done();
  };
}

export class IpLimiter {
  private hits = new Map<string, number[]>();

  constructor(private max: number, private windowMs: number) {}

  allow(ip: string): boolean {
    const cutoff = Date.now() - this.windowMs;
    const arr = (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.max) return false;
    arr.push(Date.now());
    this.hits.set(ip, arr);
    return true;
  }
}

export function humanName(key: KeyRow): string {
  return key.label ?? `user-${key.id.slice(-4)}`;
}