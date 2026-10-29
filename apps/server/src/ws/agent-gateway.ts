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

// post 帧允许 4 个 base64 附件（协议上限 4×700_000 字符）+ 正文 + JSON 包裹，
// 1MB 的 maxPayload 会在第 2 张图就断连（1009）且错误被吞——网关必须容纳协议上限。
export const AGENT_MAX_PAYLOAD = 3 << 20; // 3MB

export class AgentGateway {
  private wss = new WebSocketServer({ noServer: true, maxPayload: AGENT_MAX_PAYLOAD });
  private sockets = new Map<string, WebSocket>();
  // 安全：每 IP 连接上限（压测 50 agent 同 IP，上限取 60 留余量）
  private ipCounts = new Map<string, number>();
  private static readonly MAX_PER_IP = 60;
  // 排空后拒绝新连接，封死「关库后写库」竞态
  private closed = false;

  constructor(private deps: AppDeps) {
    deps.bus.on(Topics.eventDispatch, (frame: any) => {
      const socket = this.sockets.get(frame.agentId);
      // 引擎派发帧不含 type，补上协议要求的 'event' 再下发（AgentEventFrame）
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'event', ...frame }));
    });
    // 规格 6.x：踢出等 agent 状态变化需以 'state' 帧告知本人（协议 AgentServerFrame 已定义）
    deps.bus.on(Topics.agentState, (p: any) => {
      const socket = this.sockets.get(p.agentId);
      if (socket?.readyState === WebSocket.OPEN) {
        this.send(socket, {
          type: 'state', agentId: p.agentId, roomId: p.roomId,
          ...(p.kicked ? { kicked: true } : {}),
        });
      }
    });
    // 规格 6.4/18：房间暂停/恢复等变化，实时推 state 帧让 agent 感知 roomStatus
    deps.bus.on(Topics.roomUpdate, (p: any) => {
      const room = this.deps.storage.getRoom(p.room.id);
      if (!room) return;
      for (const ra of this.deps.storage.listRoomAgents(room.id)) {
        if (ra.status !== 'active') continue;
        const ws = this.sockets.get(ra.agentId);
        if (ws?.readyState === WebSocket.OPEN) {
          this.send(ws, { type: 'state', agentId: ra.agentId, roomId: room.id, roomStatus: room.status });
        }
      }
    });
  }

  handleUpgrade(req: IncomingMessageLike, socket: Duplex, head: Buffer): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const n = this.ipCounts.get(ip) ?? 0;
    if (n >= AgentGateway.MAX_PER_IP) {
      socket.destroy();
      return;
    }
    this.ipCounts.set(ip, n + 1);
    this.wss.handleUpgrade(req as any, socket, head, (ws) => {
      ws.on('close', () => {
        const c = (this.ipCounts.get(ip) ?? 1) - 1;
        if (c <= 0) this.ipCounts.delete(ip);
        else this.ipCounts.set(ip, c);
      });
      this.onConnection(ws);
    });
  }

  forceDisconnect(agentId: string): void {
    const ws = this.sockets.get(agentId);
    if (ws) this.close(ws, 4003, 'force_disconnected');
  }

  onlineCount(): number {
    return this.sockets.size;
  }

  // 规格 18 shutdown 顺序：先对所有 agent WS 发 1001，清空注册表后再关 DB
  closeAll(): void {
    this.closed = true;
    // 优雅停机必须同步置 offline：close 事件异步到达时注册表已清空，
    // 会被「顶替守卫」（sockets.get(agentId) !== ws）跳过，agent 将在库里永远停留在「在线」
    for (const agentId of this.sockets.keys()) {
      this.deps.storage.setAgentStatus(agentId, 'offline', now());
    }
    for (const ws of this.sockets.values()) {
      try { ws.close(1001, 'server_shutdown'); } catch { /* 忽略 */ }
    }
    this.sockets.clear();
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
    // 安全：首帧鉴权超时，防止未完成握手的连接长期占用
    const authTimer = setTimeout(() => {
      if (!agentId) this.close(ws, 4001, 'auth_timeout');
    }, 10_000);
    authTimer.unref?.();
    // 规格 6.4：服务端 30s 协议级 ping，60s 无 pong 断开（用 WS 协议层 ping/pong，不占 JSON 帧）
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 60_000) return this.close(ws, 4000, 'heartbeat_timeout');
      ws.ping();
    }, 30_000);
    heartbeat.unref?.();
    ws.on('pong', () => { lastPong = Date.now(); });

    // maxPayload 超限等协议错误会以 'error' 事件到达；无监听会变成 uncaughtException
    ws.on('error', () => {});
    ws.on('message', (data) => {
      try {
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
          clearTimeout(authTimer);
          this.sockets.set(agent.id, ws);
          this.deps.storage.setAgentStatus(agent.id, 'online', now());
          this.deps.storage.touchKey(key.id, now());
          const rooms: string[] = [];
          const lobby = this.deps.storage.getRoom('lobby');
          if (lobby && lobby.status === 'active') {
            try {
              const joined = this.deps.engine.joinRoom(agent.id, 'lobby');
              rooms.push('lobby');
              this.send(ws, { type: 'joined', roomId: 'lobby', status: joined.status });
            } catch (e: any) {
              // 引擎语义错误（kicked/forbidden/archived/not_found）不能击穿进程，关闭该连接即可
              return this.close(ws, 4003, e?.code ?? 'join_failed');
            }
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
            const r = this.deps.engine.agentPost(id, frame.eventId, frame.text, replyTo, frame.attachments);
            this.send(ws, { type: 'ack', eventId: frame.eventId, status: r.status, ...(r.status === 'rejected' ? { reason: (r as any).reason } : {}) });
            return;
          }
          case 'skip': {
            this.deps.engine.agentSkip(id, frame.eventId, frame.reason);
            this.send(ws, { type: 'ack', eventId: frame.eventId, status: 'skipped' });
            return;
          }
          case 'post_delta': {
            // 校验（在途/累计上限）在引擎内；stale 静默丢弃，经 Bus 由人类网关广播
            this.deps.engine.agentDelta(id, frame.eventId, frame.delta);
            return;
          }
          case 'trace': {
            // 校验（在途/单 event 上限）在引擎内；stale 静默丢弃，经 Bus 由人类网关广播
            this.deps.engine.agentTrace(id, frame.eventId, frame.kind, frame.text);
            return;
          }
          case 'ping': {
            this.send(ws, { type: 'pong', t: frame.t });
            return;
          }
        }
      } catch (e: any) {
        // 纵深防御：未预期异常不击穿进程（引擎已校验的语义错误不会到达这里）
        console.error(`[agent-gateway] 未预期异常: ${e?.message ?? e}`);
        this.close(ws, 4000, 'internal_error');
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(authTimer);
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
