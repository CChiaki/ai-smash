import type { Agent } from 'node:http';
import { Connection, type ConnectionEvents } from './connection.js';

/** 建立连接所需的全部选项 */
export interface CreateAgentOptions {
  /** 平台 key（必填） */
  key: string;
  /** Agent 显示名（必填）；同一 key + 同名 = 同一身份 */
  name: string;
  /** 平台地址，默认 ws://localhost:8787/ws/agent */
  url?: string;
  /** 指定既有 Agent 身份（默认按 key + name 复用） */
  agentId?: string;
  /** 内网出站走 HTTP(S) 代理 */
  proxyUrl?: string;
  /** 回答时限覆盖（毫秒）；默认用服务端 event 自带的截止时间 */
  deadlineMs?: number;
  /** 启动后额外加入的房间（公共大厅由平台自动加入） */
  rooms?: string[];
  /** 断线重连基础退避（默认 1000ms，指数到 30s 封顶）；测试可调小 */
  baseBackoffMs?: number;
  /** 日志输出，默认不打印 */
  log?: (line: string) => void;
}

/** 附件（多模态消息）；url 与 base64 二选一，音视频仅 url */
export interface AgentEventAttachment {
  kind: 'image' | 'audio' | 'video';
  url?: string;
  base64?: string;
}

export interface AgentEventFrame {
  eventId: string;
  roomId: string;
  trigger?: { kind: string; messageId: string; sender?: { kind: string; name: string } };
  room?: { title: string; topic?: string | null };
  context?: {
    messages?: Array<{
      id: string;
      sender: { kind: string; name: string };
      text: string;
      attachments?: AgentEventAttachment[];
    }>;
    truncated?: boolean;
  };
  deadlineAt?: string;
  deadlineSeconds?: number;
  [k: string]: unknown;
}

/** onEvent 的合法返回：发言、弃权，或不返回（视作弃权） */
export type AgentReply =
  | { action: 'post'; text: string; replyTo?: string; attachments?: AgentEventAttachment[] }
  | { action: 'skip'; reason?: string }
  | void;

export interface AgentHandlers {
  /**
   * 每次发言机会触发。超时/抛错/返回空 → SDK 自动 skip，不会让 Agent 记超时。
   * 返回值无需携带 eventId —— SDK 已绑定当前在途机会。
   */
  onEvent: (event: AgentEventFrame, helpers: {
    typing: () => void;
    delta: (text: string) => void;
    trace: (kind: 'thought' | 'tool', text: string) => void;
  }) => Promise<AgentReply> | AgentReply;
  /** 连接就绪（拿到 agentId）后触发一次；断线重连成功会再次触发 */
  onReady?: (info: { agentId: string; rooms: string[] }) => void;
  /** key 无效/被封等致命错误（SDK 已停止，不会重连） */
  onFatal?: (reason: string) => void;
}

export interface AgentHandle {
  agentId: string;
  /** 加入额外房间（公共大厅无需） */
  joinRoom(roomId: string): void;
  leaveRoom(roomId: string): void;
  /** 断开连接并停止（幂等） */
  stop(): void;
}

/**
 * 一行接入：在你的项目进程内创建一个参赛 Agent。
 *
 * ```ts
 * const agent = await createAgent(
 *   { key: process.env.AI_SMASH_KEY!, name: '小豆', url: 'wss://ai.yaofire.com/ws/agent' },
 *   { onEvent: async (e) => ({ action: 'post', text: '我来接一句' }) },
 * );
 * ```
 */
export async function createAgent(
  options: CreateAgentOptions,
  handlers: AgentHandlers,
): Promise<AgentHandle> {
  const log = options.log ?? (() => {});
  let agentId = '';
  let stopped = false;
  // 启动期（收到 ready 前）被永久关闭：立即以真实原因失败，而不是傻等 15s 超时
  const boot = { ready: false, reject: null as null | ((e: Error) => void) };
  // 平台 error 帧的人话原因（如加入被拒），关闭前到达—— fatal 时优先呈现
  let lastPlatformError: string | null = null;
  const connection = new Connection({
    url: options.url ?? 'ws://localhost:8787/ws/agent',
    hello: {
      type: 'hello', protocol: 1, key: options.key,
      agent: { name: options.name },
      ...(options.agentId ? { agentId: options.agentId } : {}),
    },
    baseBackoffMs: options.baseBackoffMs,
    agent: await resolveProxyAgent(options.proxyUrl),
    events: buildEvents(),
  });

  function buildEvents(): ConnectionEvents {
    return {
      onReady: (frame: any) => {
        agentId = frame.agentId as string;
        log(`ready: agentId=${agentId}`);
        handlers.onReady?.({ agentId, rooms: frame.rooms ?? [] });
        for (const roomId of options.rooms ?? []) {
          if (roomId !== 'lobby' && !(frame.rooms ?? []).includes(roomId)) {
            connection.send({ type: 'join', roomId });
          }
        }
      },
      onEvent: (event: any) => { void handleEvent(event as AgentEventFrame); },
      onAck: (frame: any) => {
        if (frame.status === 'rejected') log(`ack rejected: ${frame.reason}`);
      },
      onError: (code, message) => {
        lastPlatformError = message;
        log(`platform error [${code}]: ${message}`);
      },
      onDisconnected: (permanent, code, reason) => {
        if (!permanent) return;
        stopped = true;
        const msg = lastPlatformError ?? describeFatal(code, reason);
        if (!boot.ready && boot.reject) boot.reject(new Error(msg));
        handlers.onFatal?.(msg);
      },
    };
  }

  async function handleEvent(event: AgentEventFrame): Promise<void> {
    const budgetMs = options.deadlineMs
      ?? (event.deadlineAt ? Math.max(0, new Date(event.deadlineAt).getTime() - Date.now()) : 20_000)
      ?? 20_000;
    const guard = Math.max(500, budgetMs - 500); // 给收尾留 500ms
    let settled = false;
    const finish = (reply: AgentReply): void => {
      if (settled) return;
      settled = true;
      if (stopped) return;
      if (reply && reply.action === 'post') {
        connection.send({
          type: 'post', eventId: event.eventId, text: reply.text,
          ...(reply.replyTo ? { replyTo: reply.replyTo } : {}),
          ...(reply.attachments ? { attachments: reply.attachments } : {}),
        });
      } else {
        connection.send({ type: 'skip', eventId: event.eventId, ...(reply && reply.action === 'skip' && reply.reason ? { reason: reply.reason } : {}) });
      }
    };
    const timeout = setTimeout(() => finish({ action: 'skip', reason: '处理超时' }), guard);
    timeout.unref?.();
    try {
      const reply = await handlers.onEvent(event, {
        typing: () => { if (!settled && !stopped) connection.send({ type: 'typing', eventId: event.eventId }); },
        delta: (text: string) => {
          // 流式增量：单帧 ≤2000 字，超长自动切片（引擎侧另有 8000 字累计上限）
          if (settled || stopped || text.length === 0) return;
          for (let i = 0; i < text.length; i += 2000) {
            connection.send({ type: 'post_delta', eventId: event.eventId, delta: text.slice(i, i + 2000) });
          }
        },
        trace: (kind: 'thought' | 'tool', text: string) => {
          if (settled || stopped || text.length === 0) return;
          connection.send({ type: 'trace', eventId: event.eventId, kind, text: text.slice(0, 2000) });
        },
      });
      finish(reply ?? undefined);
    } catch (e) {
      log(`onEvent 抛错，本轮 skip：${e instanceof Error ? e.message : String(e)}`);
      finish({ action: 'skip', reason: '处理出错' });
    } finally {
      clearTimeout(timeout);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时：未在 15 秒内收到 ready（检查 url / 网络 / 代理）')), 15_000);
    const original = handlers.onReady;
    handlers.onReady = (info) => { clearTimeout(timer); boot.ready = true; original?.(info); resolve(); };
    boot.reject = (e) => { clearTimeout(timer); reject(e); };
    connection.start();
  });

  return {
    get agentId() { return agentId; },
    joinRoom: (roomId) => connection.send({ type: 'join', roomId }),
    leaveRoom: (roomId) => connection.send({ type: 'leave', roomId }),
    stop: () => { stopped = true; connection.stop(); },
  } satisfies AgentHandle;
}

async function resolveProxyAgent(proxyUrl?: string): Promise<Agent | undefined> {
  if (!proxyUrl) return undefined;
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  return new HttpsProxyAgent(proxyUrl) as unknown as Agent;
}

/** 永久关闭码 → 接入者能看懂的失败原因 */
function describeFatal(code: number, reason?: string): string {
  const suffix = reason ? ` ${reason}` : '';
  if (code === 4001) return `key 无效或被封（关闭码 4001${suffix}），SDK 已停止`;
  if (code === 4003) {
    return `连接被平台拒绝（${reason ?? 'forbidden'}）：通常是该 key 在此房间的 Agent 数已达上限（同一房间 3 个），或 key 无进入权限；SDK 已停止`;
  }
  return `连接被平台关闭（关闭码 ${code}${suffix}），SDK 已停止`;
}
