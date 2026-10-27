export interface BridgeConfig {
  url: string;
  key: string;
  name: string;
  agentId?: string;
  deadlineMs?: number;
  proxyUrl?: string;
  command?: string[];
  demo: boolean;
  rooms: string[]; // 启动后主动加入的房间（lobby 由平台自动加入，无需传）
}

export function parseArgs(argv: readonly string[]): BridgeConfig {
  let demo = false;
  let url = 'ws://localhost:8787/ws/agent';
  let key: string | undefined;
  let name: string | undefined;
  let agentId: string | undefined;
  let deadlineMs: number | undefined;
  // 内网部署：agent 出站 WS 经 HTTP 代理（规格 16.2）；端到端代理隧道验证属 2 期
  let proxyUrl: string | undefined;
  let command: string[] | undefined;
  const rooms: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      command = argv.slice(i + 1);
      break;
    } else if (a === 'demo') {
      demo = true;
    } else if (a === '--key') {
      key = argv[++i];
    } else if (a === '--name') {
      name = argv[++i];
    } else if (a === '--url') {
      url = argv[++i];
    } else if (a === '--agent-id') {
      agentId = argv[++i];
    } else if (a === '--deadline') {
      deadlineMs = Number(argv[++i]);
    } else if (a === '--room') {
      rooms.push(argv[++i]);
    } else if (a === '--proxy') {
      proxyUrl = argv[++i];
      if (!proxyUrl) throw new Error('--proxy 缺少取值');
    } else if (a === '--command') {
      command = (argv[++i] ?? '').split(/\s+/).filter((s) => s.length > 0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  // 环境变量兜底（避免 key 出现在 shell 历史里）：AI_SMASH_KEY / AI_SMASH_NAME / AI_SMASH_URL / AI_SMASH_PROXY
  key = key ?? process.env.AI_SMASH_KEY;
  name = name ?? process.env.AI_SMASH_NAME;
  url = process.env.AI_SMASH_URL ?? url;
  proxyUrl = proxyUrl ?? process.env.AI_SMASH_PROXY;
  if (!key) throw new Error('缺少 --key（或环境变量 AI_SMASH_KEY）');
  if (!name) throw new Error('缺少 --name（或环境变量 AI_SMASH_NAME）');
  if (!demo && (!command || command.length === 0)) throw new Error('需要 --command 或 -- <命令...>');
  if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000)) {
    throw new Error('--deadline 需为 1-60000 的整数毫秒');
  }
  if (proxyUrl !== undefined) {
    let ok = proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://');
    if (ok) { try { new URL(proxyUrl); } catch { ok = false; } }
    if (!ok) throw new Error('--proxy 需为合法的 http(s):// 代理地址');
  }
  return { url, key, name, agentId, deadlineMs, proxyUrl, command, demo, rooms };
}
