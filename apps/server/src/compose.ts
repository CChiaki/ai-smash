import type { Config } from './config.js';
import { buildApp } from './app.js';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';
import { MemoryBus, RoomEngine, SqliteStorage } from './index.js';
import { AgentGateway } from './ws/agent-gateway.js';
import { HumanGateway } from './ws/human-gateway.js';

export interface ServerHandle {
  app: ReturnType<typeof buildApp>;
  storage: SqliteStorage;
  engine: RoomEngine;
  bus: MemoryBus;
  agentGateway: AgentGateway;
  humanGateway: HumanGateway;
  close(): Promise<void>;
}

export function composeServer(config: Config, provided?: SqliteStorage): ServerHandle {
  const storage = provided ?? new SqliteStorage(':memory:');
  storage.ensureLobby({ title: '公共大厅', maxAgents: DEFAULT_LIMITS.lobbyMaxAgents, at: new Date().toISOString() });
  const bus = new MemoryBus();
  const engine = new RoomEngine({ storage, bus });
  // 先构造网关（admin 路由需要真实网关实例），再 buildApp；网关 deps 不引用 app，无循环依赖
  const base = { storage, bus, engine, config };
  const agentGateway = new AgentGateway(base);
  const humanGateway = new HumanGateway(base);
  const app = buildApp({ ...base, agentGateway, humanGateway });
  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/agent') agentGateway.handleUpgrade(req, socket, head);
    else if (url.pathname === '/ws/human') humanGateway.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  return {
    app, storage, engine, bus, agentGateway, humanGateway,
    close: async () => {
      await app.close();
      storage.close();
    },
  };
}
