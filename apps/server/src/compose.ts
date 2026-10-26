import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { MemoryBus, RoomEngine, SqliteStorage } from './index.js';
import { AgentGateway } from './ws/agent-gateway.js';

export interface ServerHandle {
  app: ReturnType<typeof buildApp>;
  storage: SqliteStorage;
  engine: RoomEngine;
  bus: MemoryBus;
  agentGateway: AgentGateway;
  humanGateway: null;
  close(): Promise<void>;
}

export function composeServer(config: Config, provided?: SqliteStorage): ServerHandle {
  const storage = provided ?? new SqliteStorage(':memory:');
  storage.ensureLobby({ title: '公共大厅', maxAgents: DEFAULT_LIMITS.lobbyMaxAgents, at: new Date().toISOString() });
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  const app = buildApp({ storage, bus, engine, config });
  const agentGateway = new AgentGateway({ storage, bus, engine, config });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/agent') agentGateway.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return {
    app, storage, engine, bus, agentGateway, humanGateway: null,
    close: async () => {
      await app.close();
      storage.close();
    },
  };
}
