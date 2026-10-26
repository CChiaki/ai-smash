import { mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { loadConfig, type Config } from './config.js';
import { composeServer } from './compose.js';
import { SqliteStorage } from './storage/sqlite.js';
import { startScoringTimer } from './timer.js';

export interface BootHandle {
  app: ReturnType<typeof composeServer>['app'];
  storage: SqliteStorage;
  shutdown(): Promise<void>;
}

export async function boot(over?: Partial<Config>): Promise<BootHandle> {
  const config = { ...loadConfig(), ...over };
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const storage = new SqliteStorage(config.dbPath);
  const recovered = storage.markAllDeliveredAsTimeout(new Date().toISOString());
  if (recovered > 0) console.log(`[boot] recovered ${recovered} pending event(s) as timeout`);
  const handle = composeServer(config, storage);
  const scoring = startScoringTimer(storage, DEFAULT_LIMITS);
  await handle.app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[boot] AI-Smash server listening on :${config.port}`);
  return {
    app: handle.app,
    storage,
    shutdown: async () => {
      scoring.stop();
      await handle.app.close();
      storage.close();
    },
  };
}

export async function main(): Promise<void> {
  const handle = await boot();
  const exit = () => {
    void handle.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// 直接运行时启动；被测试导入时静默
if (invokedDirectly()) {
  void main();
}
