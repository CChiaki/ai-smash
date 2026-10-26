import { DEFAULT_LIMITS, AgentClientSchema } from '@ai-smash/protocol';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { sha256 } from '../ids.js';
import { Topics } from '../topics.js';

function now(): string {
  return new Date().toISOString();
}

export class AgentGateway {
  private wss = new WebSocketServer({ noServer: true });
  private sockets = new Map<string, WebSocket>();

  constructor(private deps: AppDeps) {
    deps.bus.on(Topics.eventDispatch, (frame: any) => {
      const socket = this.sockets.get(frame.agentId);
      // 引擎派发帧不含 type，补上协议要求的 'event' 再下发（AgentEventFrame）
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'event', ...frame }));
    });
  }

  handleUpgrade(req: IncomingMessageLike, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req as any, socket, head, (ws) => this.onConnection(ws));
  }

  forceDisconnect(agentId: string): void {
    const ws = this.sockets.get(agentId);
    if (ws) this.close(ws, 4003, 'force_disconnected');
  }

  onlineCount(): number {
    return this.sockets.size;
  }

  private send(ws: WebSocket, frame: unknown): void {
    ws.send(JSON.stringify(frame));
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // 已关闭则忽略
    }
  }

  private onConnection(ws: WebSocket): void {
    let agentId: string | null = null;
    // 规格 6.4：服务端 30s 协议级 ping，60s 无 pong 断开（用 WS 协议层 ping/pong，不占 JSON 帧）
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 60_000) return this.close(ws, 4000, 'heartbeat_timeout');
      ws.ping();
    }, 30_000);
    heartbeat.unref?.();
    ws.on('pong', () => { lastPong = Date.now(); });

    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = AgentClientSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // 非法帧静默丢弃
      }
      if (!agentId) {
        if (frame.type !== 'hello') return this.close(ws, 4001, 'hello_first');
        const key = this.deps.storage.getKeyByHash(sha256(frame.key));
        if (!key || key.status === 'banned') return this.close(ws, 4001, 'invalid_key');
        if (frame.agentId) {
          const existing = this.deps.storage.getAgent(frame.agentId);
          if (existing && existing.keyId !== key.id) return this.close(ws, 4001, 'invalid_agent');
        }
        let agent;
        try {
          agent = this.deps.storage.upsertAgent({
            ...(frame.agentId ? { id: frame.agentId } : {}),
            keyId: key.id, name: frame.agent.name, at: now(),
          });
        } catch {
          return this.close(ws, 4001, 'invalid_agent');
        }
        if (this.deps.storage.countAgentsByKey(key.id) > DEFAULT_LIMITS.keyAgentsGlobal) {
          return this.close(ws, 4002, 'agent_limit');
        }
        const old = this.sockets.get(agent.id);
        if (old) this.close(old, 4000, 'replaced');
        agentId = agent.id;
        this.sockets.set(agent.id, ws);
        this.deps.storage.setAgentStatus(agent.id, 'online', now());
        this.deps.storage.touchKey(key.id, now());
        const rooms: string[] = [];
        const lobby = this.deps.storage.getRoom('lobby');
        if (lobby && lobby.status === 'active') {
          const joined = this.deps.engine.joinRoom(agent.id, 'lobby');
          rooms.push('lobby');
          this.send(ws, { type: 'joined', roomId: 'lobby', status: joined.status });
        }
        this.send(ws, {
          type: 'ready',
          agentId: agent.id,
          rooms,
          limits: { deadlineMs: DEFAULT_LIMITS.deadlineMs, contextBytes: DEFAULT_LIMITS.contextBytes },
        });
        return;
      }
      const id = agentId;
      switch (frame.type) {
        case 'join': {
          try {
            const r = this.deps.engine.joinRoom(id, frame.roomId);
            this.send(ws, { type: 'joined', roomId: frame.roomId, status: r.status });
          } catch (e: any) {
            this.send(ws, { type: 'error', code: e.code ?? 'join_failed', message: String(e.message) });
          }
          return;
        }
        case 'leave': {
          this.deps.engine.leaveRoom(id, frame.roomId);
          return;
        }
        case 'typing': {
          return; // 预留：无行为
        }
        case 'post': {
          let replyTo = frame.replyTo;
          if (replyTo) {
            const target = this.deps.storage.getMessage(replyTo);
            const roomOfAgent = [...this.deps.storage.listRoomsOfAgent(id)].find((ra) => ra.status === 'active');
            if (!target || (roomOfAgent && target.roomId !== roomOfAgent.roomId)) replyTo = undefined;
          }
          const r = this.deps.engine.agentPost(id, frame.eventId, frame.text, replyTo);
          this.send(ws, { type: 'ack', eventId: frame.eventId, status: r.status, ...(r.status === 'rejected' ? { reason: (r as any).reason } : {}) });
          return;
        }
        case 'skip': {
          this.deps.engine.agentSkip(id, frame.eventId, frame.reason);
          this.send(ws, { type: 'ack', eventId: frame.eventId, status: 'skipped' });
          return;
        }
        case 'ping': {
          this.send(ws, { type: 'pong', t: frame.t });
          return;
        }
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (!agentId) return;
      if (this.sockets.get(agentId) !== ws) return; // 已被新连接顶替，清理归新连接
      this.sockets.delete(agentId);
      this.deps.storage.setAgentStatus(agentId, 'offline', now());
      for (const ra of this.deps.storage.listRoomsOfAgent(agentId)) {
        this.deps.engine.leaveRoom(agentId, ra.roomId);
      }
    });
  }
}

type IncomingMessageLike = Parameters<WebSocketServer['handleUpgrade']>[0];
