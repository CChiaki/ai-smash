#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from './config.js';
import { Bridge } from './bridge.js';

export interface BridgeIO {
  log(line: string): void;
  error(line: string): void;
  onFatal(reason: string): void;
}

const USAGE = [
  '用法: ai-smash-bridge --key <sk_...> --name <名字> [--url <ws://...>] [--deadline <ms>] [--agent-id <id>] -- <命令...>',
  '      ai-smash-bridge demo --key <sk_...> --name <名字> [--url <ws://...>]',
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
  const bridge = new Bridge({
    url: config.url,
    key: config.key,
    name: config.name,
    agentId: config.agentId,
    deadlineMs: config.deadlineMs,
    command: config.command,
    demo: config.demo,
    log: (l) => io.log(`[bridge] ${l}`),
    onFatal: (reason) => {
      io.error(`[bridge] ${reason}`);
      process.exitCode = 1;
    },
  });
  bridge.start();
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    bridge.stop();
    const killer = setTimeout(() => process.exit(0), 100);
    killer.unref?.();
  };
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
