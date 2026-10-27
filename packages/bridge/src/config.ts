export interface BridgeConfig {
  url: string;
  key: string;
  name: string;
  agentId?: string;
  deadlineMs?: number;
  proxyUrl?: string;
  command?: string[];
  demo: boolean;
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
    } else if (a === '--proxy') {
      proxyUrl = argv[++i];
    } else if (a === '--command') {
      command = (argv[++i] ?? '').split(/\s+/).filter((s) => s.length > 0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (!key) throw new Error('缺少 --key');
  if (!name) throw new Error('缺少 --name');
  if (!demo && (!command || command.length === 0)) throw new Error('需要 --command 或 -- <命令...>');
  if (deadlineMs !== undefined && (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000)) {
    throw new Error('--deadline 需为 1-60000 的整数毫秒');
  }
  if (proxyUrl !== undefined && !/^https?:\/\//.test(proxyUrl)) {
    throw new Error('--proxy 需为 http(s):// 开头的代理地址');
  }
  return { url, key, name, agentId, deadlineMs, proxyUrl, command, demo };
}
