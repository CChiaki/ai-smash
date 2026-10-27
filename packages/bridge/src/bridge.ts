import { Connection } from './connection.ts';
import { ChildRunner } from './child.ts';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface BridgeDeps {
  url: string;
  key: string;
  name: string;
  agentId?: string;
  deadlineMs?: number;
  proxyUrl?: string;
  command?: string[];
  demo: boolean;
  rooms?: string[];
  log(line: string): void;
  onFatal(reason: string): void;
  baseBackoffMs?: number;
  baseDelayMs?: number;
  maxRestarts?: number;
  windowMs?: number;
}

interface Pending {
  eventId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class Bridge {
  private connection: Connection;
  private child: ChildRunner | null = null;
  private pending: Pending | null = null;

  private deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    const hello: Record<string, unknown> = {
      type: 'hello', protocol: 1, key: deps.key, agent: { name: deps.name },
    };
    if (deps.agentId) hello.agentId = deps.agentId;
    // 规格 16.2：内网部署时出站 WS 经 HTTP 代理隧道；HttpsProxyAgent 与 ws 的 agent 选项兼容
    const agent = deps.proxyUrl ? new HttpsProxyAgent(deps.proxyUrl) : undefined;
    this.connection = new Connection({
      url: deps.url,
      hello,
      baseBackoffMs: deps.baseBackoffMs,
      agent,
      events: {
        onReady: (frame) => {
          deps.log(`ready: agentId=${frame.agentId}`);
          // 平台在 hello 时已自动加入大厅；这里补发用户显式指定的房间
          for (const roomId of deps.rooms ?? []) {
            if (roomId !== 'lobby' && !frame.rooms?.includes(roomId)) {
              this.connection.send({ type: 'join', roomId });
            }
          }
        },
        onAck: (frame) => {
          if (frame.status === 'rejected') deps.log(`ack rejected: ${frame.reason}`);
        },
        onEvent: (frame) => this.handleEvent(frame),
        onDisconnected: (permanent, code) => {
          this.clearPending();
          if (permanent) this.deps.onFatal(`key 无效或被封（关闭码 ${code}），退出`);
        },
      },
    });
    if (!deps.demo && deps.command) {
      this.child = new ChildRunner(deps.command, {
        onOutput: (frame, raw) => this.handleChildOutput(frame, raw),
        onCrash: () => deps.log('子进程崩溃，退避重启'),
        onFatal: () => deps.onFatal('子进程在窗口期内崩溃次数过多，退出'),
      }, { baseDelayMs: deps.baseDelayMs, maxRestarts: deps.maxRestarts, windowMs: deps.windowMs });
    }
  }

  start(): void {
    this.connection.start();
    this.child?.start();
  }

  stop(): void {
    this.connection.stop();
    this.child?.stop();
    this.clearPending();
  }

  private handleEvent(frame: any): void {
    if (this.deps.demo) {
      this.connection.send({ type: 'typing', eventId: frame.eventId });
      const timer = setTimeout(() => {
        const last = frame.context?.messages?.at(-1)?.text ?? '';
        this.connection.send({
          type: 'post',
          eventId: frame.eventId,
          text: `（demo 回声）收到 ${frame.trigger?.sender?.name ?? '有人'} 说：${String(last).slice(0, 50)}`,
        });
      }, 300);
      timer.unref?.();
      return;
    }
    this.clearPending();
    const eventId: string = frame.eventId;
    this.pending = { eventId, timer: null };
    const serverDeadlineMs = Math.max(0, new Date(frame.deadlineAt).getTime() - Date.now());
    const childDeadlineMs = this.deps.deadlineMs ?? serverDeadlineMs;
    this.child?.sendEvent({ ...frame, deadlineSeconds: Math.round(childDeadlineMs / 100) / 10 });
    const timer = setTimeout(() => {
      if (this.pending?.eventId !== eventId) return;
      this.deps.log('子进程超时，代发 skip');
      this.connection.send({ type: 'skip', eventId });
      this.clearPending();
    }, childDeadlineMs);
    timer.unref?.();
    this.pending.timer = timer;
  }

  private handleChildOutput(frame: any, raw: string): void {
    if (frame === null) {
      this.deps.log(`丢弃非法输出: ${String(raw).slice(0, 200)}`);
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.deps.log('丢弃迟到输出（无在途事件）');
      return;
    }
    if (frame.action === 'typing') {
      this.connection.send({ type: 'typing', eventId: pending.eventId });
      return;
    }
    if (frame.action === 'post') {
      this.connection.send({
        type: 'post', eventId: pending.eventId, text: frame.text,
        ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
      });
    } else {
      this.connection.send({
        type: 'skip', eventId: pending.eventId,
        ...(frame.reason ? { reason: frame.reason } : {}),
      });
    }
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
