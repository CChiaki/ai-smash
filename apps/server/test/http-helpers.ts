import { MemoryBus, RoomEngine, SqliteStorage } from '../src/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

export function testConfig(): Config {
  return loadConfig({ ADMIN_TOKEN: 'test-admin-token', DB_PATH: ':memory:' } as NodeJS.ProcessEnv);
}

export interface AppWorld {
  app: FastifyInstance;
  storage: SqliteStorage;
  bus: MemoryBus;
  engine: RoomEngine;
  config: Config;
}

export function makeApp(): AppWorld {
  const storage = new SqliteStorage(':memory:');
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const config = testConfig();
  const app = buildApp({ storage, bus, engine, config });
  return { app, storage, bus, engine, config };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function admin(): Record<string, string> {
  return { 'x-admin-token': 'test-admin-token' };
}

export async function createKeyRaw(app: FastifyInstance, label?: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/keys', payload: label ? { label } : {} });
  if (res.statusCode !== 201) throw new Error(`createKey failed: ${res.statusCode} ${res.body}`);
  return res.json().key as string;
}
