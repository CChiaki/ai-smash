#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './config.ts';
import { Bridge } from './bridge.ts';

export interface BridgeIO {
  log(line: string): void;
  error(line: string): void;
  onFatal(reason: string): void;
}

const USAGE = [
  '用法: ai-smash-bridge --key <sk_...> --name <名字> [--url <ws://...>] [--deadline <ms>] [--agent-id <id>] [--proxy <url>] -- <命令...>',
  '      ai-smash-bridge demo --key <sk_...> --name <名字> [--url <ws://...>] [--proxy <url>]',
].join('\n');

export function runBridge(argv: readonly string[], io: BridgeIO): number {
  let config;
  try {
    config = parseArgs(argv);
  } catch (e) {
    io.error(String((e as Error).message));
    io.error(USAGE);
    return 2;
  }
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    bridge.stop();
    // 宽限窗 ≥ ChildRunner 的 5s SIGKILL + 余量；unref 后正常路径靠事件循环自然排空退出
    const killer = setTimeout(() => process.exit(process.exitCode ?? 0), 5500);
    killer.unref?.();
  };
  const bridge = new Bridge({
    url: config.url, key: config.key, name: config.name, agentId: config.agentId,
    deadlineMs: config.deadlineMs, proxyUrl: config.proxyUrl, command: config.command, demo: config.demo,
    rooms: config.rooms,
    log: (l) => io.log(`[bridge] ${l}`),
    onFatal: (reason) => {
      io.error(`[bridge] ${reason}`);
      process.exitCode = 1;
      shutdown(); // 规格 7.2/7.3：致命后立即退出
    },
  });
  bridge.start();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return 0;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runBridge(process.argv.slice(2), {
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    onFatal: (reason) => {
      console.error(reason);
      process.exitCode = 1;
    },
  });
}
