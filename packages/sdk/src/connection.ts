import { WebSocket } from 'ws';
import type { Agent } from 'node:http';
import { AgentServerSchema } from '@ai-smash/protocol';

export interface ConnectionEvents {
  onReady(frame: any): void;
  onEvent(frame: any): void;
  onAck(frame: any): void;
  /** 平台下发的 error 帧（如加入被拒的明确原因）；多在关闭前到达 */
  onError?(code: string, message: string): void;
  onDisconnected(permanent: boolean, code: number, reason?: string): void;
}

export interface ConnectionDeps {
  url: string;
  hello: unknown;
  events: ConnectionEvents;
  baseBackoffMs?: number;
  // 出站代理（规格 16.2）：内网部署时 WS 连接经 HTTP CONNECT 隧道
  agent?: Agent;
}

export class Connection {
  private ws: WebSocket | null = null;
  private backoffMs: number;
  private stopped = false;
  private readonly baseBackoffMs: number;

  private deps: ConnectionDeps;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000;
    this.backoffMs = this.baseBackoffMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.ws?.close(1000, 'bridge_shutdown');
    } catch {
      // 忽略
    }
  }

  send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.deps.url, this.deps.agent ? { agent: this.deps.agent } : undefined);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify(this.deps.hello));
    });
    ws.on('message', (data) => {
      let frame: any;
      try {
        frame = AgentServerSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // 非法帧静默丢弃
      }
      if (frame.type === 'ready') {
        this.backoffMs = this.baseBackoffMs;
        this.deps.events.onReady(frame);
      } else if (frame.type === 'event') {
        this.deps.events.onEvent(frame);
      } else if (frame.type === 'ack') {
        this.deps.events.onAck(frame);
      } else if (frame.type === 'error') {
        this.deps.events.onError?.(frame.code, frame.message);
      }
    });
    ws.on('close', (code, reason) => {
      if (this.stopped) return;
      // 4001 = key 无效/被封；4003 = 引擎语义拒绝（房间配额满/无权限/被踢）——
      // 二者重连也不会成功（4003 尤其会被同一堵墙反复拒绝），都按永久断开处理
      const permanent = code === 4001 || code === 4003;
      this.deps.events.onDisconnected(permanent, code, reason?.toString());
      if (permanent) return; // 不重试，由上层退出
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      const timer = setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
      timer.unref?.();
    });
    ws.on('error', () => {
      // close 会跟随触发
    });
  }
}
