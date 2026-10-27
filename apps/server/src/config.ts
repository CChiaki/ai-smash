import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * 极简 .env 加载：存在则读入，不覆盖已有环境变量（systemd/容器注入优先）。
 * 支持 KEY=VALUE、# 注释、成对引号去除。
 */
export function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
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
}

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_TOKEN: z.string().min(8),
  DB_PATH: z.string().default('./data/ai-smash.db'),
  PUBLIC_BASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  CORS_ORIGIN: z.string().optional(),
});

export type Config = {
  port: number;
  adminToken: string;
  dbPath: string;
  publicBaseUrl?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
  trustProxy: boolean;
  corsOrigin?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadDotEnv(); // 默认从启动目录的 .env 兜底；显式传入 env 的调用方（测试）不受影响
  const parsed = ConfigSchema.parse(env);
  return {
    port: parsed.PORT,
    adminToken: parsed.ADMIN_TOKEN,
    dbPath: parsed.DB_PATH,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    logLevel: parsed.LOG_LEVEL,
    trustProxy: parsed.TRUST_PROXY,
    corsOrigin: parsed.CORS_ORIGIN,
  };
}
