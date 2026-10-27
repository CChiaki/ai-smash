#!/usr/bin/env node
/**
 * AI大乱斗 · LLM 聊天 Agent 示例（apps/demo）
 *
 * 形态：bridge 子进程。stdin 收 event（一行 JSON），stdout 回应（一行 JSON）。
 * 大模型：OpenAI 兼容 /chat/completions，配置读 apps/demo/.env（环境变量优先）。
 * 行为：收到发言机会 → 先发 typing → 调 LLM → post（回复触发消息）；超时/出错 → skip。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── 配置 ─────────────────────────────────────────────

export interface DemoConfig {
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
    return; // 只读第一个命中的文件
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const baseUrl = env.LLM_BASE_URL?.replace(/\/+$/, '');
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('缺少 LLM 配置：请在 apps/demo/.env 填写 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（模板见 .env.example）');
  }
  return { baseUrl, apiKey, model, persona: env.PERSONA?.trim() || DEFAULT_PERSONA };
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
  cfg: DemoConfig,
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
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: 300,
        temperature: 0.8,
      }),
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
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  return text;
}

// ── 主循环（作为 bridge 子进程运行）──────────────────

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleEvent(event: any, cfg: DemoConfig): Promise<void> {
  emit({ action: 'typing' });
  // 给网络留缓冲：比截止时间提前 2 秒放弃，且至少给 3 秒
  const budgetMs = Math.max(3000, ((event?.deadlineSeconds ?? 20) - 2) * 1000);
  try {
    const messages = buildMessages({ ...event, persona: `${cfg.persona}\n` });
    let text = await callLLM(cfg, messages, budgetMs);
    text = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (text.length === 0) {
      emit({ action: 'skip', reason: '模型没有给出内容' });
      return;
    }
    emit({ action: 'post', text, replyTo: event?.trigger?.messageId });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[demo-agent] 本轮放弃：${reason}`);
    emit({ action: 'skip', reason: '模型调用失败，这轮让给别人' });
  }
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
  loadDemoEnv();
  let cfg: DemoConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(2);
  }
  console.error(`[demo-agent] 就绪：model=${cfg.model} base=${cfg.baseUrl}`);
  let busy = false;
  const queue: any[] = [];
  const drain = async (): Promise<void> => {
    if (busy || queue.length === 0) return;
    busy = true;
    const event = queue.shift();
    try {
      await handleEvent(event, cfg);
    } finally {
      busy = false;
      void drain();
    }
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      console.error(`[demo-agent] 丢弃非法输入行：${trimmed.slice(0, 100)}`);
      return;
    }
    queue.push(event);
    void drain();
  });
  void fileURLToPath; // 保留引用避免按未使用裁剪
}
