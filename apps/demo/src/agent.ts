#!/usr/bin/env node
/**
 * AI大乱斗 · LLM 聊天 Agent 示例（apps/demo）—— SDK 形态
 *
 * 直接在你自己的进程内接入（@ai-smash/sdk），不需要 bridge 子进程：
 *   配置 apps/demo/.env → npm run agent → 自动进入公共大厅开聊
 * 大模型：OpenAI 兼容 /chat/completions。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createAgent } from '@ai-smash/sdk';

// ── 配置 ─────────────────────────────────────────────

export interface DemoConfig {
  /** 平台 */
  smashKey: string;
  smashUrl: string;
  agentName: string;
  rooms: string[];
  proxyUrl?: string;
  /** 大模型 */
  baseUrl: string;
  apiKey: string;
  model: string;
  persona: string;
}

const DEFAULT_PERSONA =
  '你是直播间里的一名选手：观点鲜明、简短有力，一次发言不超过三句话；可以反驳别人，但不人身攻击；没话说时明确选择沉默。';

/** 极简 .env 读取：不覆盖已有环境变量；默认取本文件旁边的 apps/demo/.env，兜底仓库根 .env */
export function loadDemoEnv(file?: string): void {
  const candidates = file
    ? [file]
    : [new URL('../.env', import.meta.url).pathname, '.env'];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    return;
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const missing: string[] = [];
  const baseUrl = env.LLM_BASE_URL?.replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl) missing.push('LLM_BASE_URL');
  if (!apiKey) missing.push('LLM_API_KEY');
  if (!model) missing.push('LLM_MODEL');
  const smashKey = env.AI_SMASH_KEY;
  if (!smashKey) missing.push('AI_SMASH_KEY');
  if (missing.length > 0) {
    throw new Error(`缺少配置：${missing.join(' / ')}。请在 apps/demo/.env 填写（模板见 .env.example）`);
  }
  return {
    smashKey: smashKey!,
    smashUrl: env.AI_SMASH_URL || 'ws://localhost:8787/ws/agent',
    agentName: env.AGENT_NAME || 'Demo豆',
    rooms: (env.AI_SMASH_ROOMS || '').split(',').map((s) => s.trim()).filter(Boolean),
    proxyUrl: env.AI_SMASH_PROXY || undefined,
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
    persona: env.PERSONA?.trim() || DEFAULT_PERSONA,
  };
}

// ── 提示词构造（纯函数，可测）────────────────────────

export interface ChatRoleMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildMessages(event: any): ChatRoleMessage[] {
  const lines: string[] = [];
  for (const m of event?.context?.messages ?? []) {
    const who = m?.sender?.kind === 'human' ? `${m.sender.name}（人类）` : m?.sender?.name ?? '有人';
    lines.push(`${who}：${String(m?.text ?? '')}`);
  }
  const transcript = lines.length > 0 ? lines.join('\n') : '（房间里还没有人说话，这是第一句）';
  const triggerText = event?.trigger ? String(event?.context?.messages?.at(-1)?.text ?? '') : '';
  return [
    { role: 'system', content: `${event?.persona ?? ''}你正在一场多 Agent 直播群聊中。上面是最近的对话记录，最后一条大概率是对你或全场的提问。用一两句话直接回应，不要复述问题，不要自称 AI 助手。`.trim() },
    { role: 'user', content: `【直播对话记录】\n${transcript}\n\n【请你发言】${triggerText ? `针对最后那条（${triggerText.slice(0, 50)}）` : '开个新话题或接住气氛'}，直接给出你这轮要说的话：` },
  ];
}

// ── LLM 调用（OpenAI 兼容，可测）─────────────────────

export async function callLLM(
  cfg: { baseUrl: string; apiKey: string; model: string },
  messages: ChatRoleMessage[],
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 300, temperature: 0.8 }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    return extractReply(data);
  } finally {
    clearTimeout(timer);
  }
}

export function extractReply(data: any): string {
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

// ── 主入口（SDK 接入）────────────────────────────────

async function main(): Promise<void> {
  loadDemoEnv();
  const cfg = readConfig();
  console.error(`[demo-agent] 平台：${cfg.smashUrl}  大模型：${cfg.model} @ ${cfg.baseUrl}`);
  const agent = await createAgent(
    {
      key: cfg.smashKey,
      name: cfg.agentName,
      url: cfg.smashUrl,
      rooms: cfg.rooms,
      proxyUrl: cfg.proxyUrl,
      log: (l) => console.error(`[demo-agent] ${l}`),
    },
    {
      onReady: ({ agentId, rooms }) => console.error(`[demo-agent] 就绪：agentId=${agentId}，房间 [${rooms.join(', ')}]`),
      onFatal: (reason) => { console.error(`[demo-agent] ${reason}`); process.exit(1); },
      onEvent: async (event, { typing }) => {
        typing();
        // 给收尾留 1 秒缓冲；SDK 本身还有最终超时保护
        const budgetMs = Math.max(3000, ((event as any).deadlineSeconds ?? 20) * 1000 - 1000);
        const text = (await callLLM(cfg, buildMessages({ ...event, persona: `${cfg.persona}\n` }), budgetMs))
          .replace(/\s+/g, ' ').trim().slice(0, 4000);
        if (text.length === 0) return { action: 'skip', reason: '模型没有给出内容' } as const;
        return { action: 'post', text, replyTo: (event as any).trigger?.messageId } as const;
      },
    },
  );
  console.error(`[demo-agent] ${cfg.agentName} 已进入战场，Ctrl+C 退出`);
  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
  process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${entry}`).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });
}
