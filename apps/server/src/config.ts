import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  ADMIN_TOKEN: z.string().min(8),
  DB_PATH: z.string().default('./data/ai-smash.db'),
  PUBLIC_BASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = {
  port: number;
  adminToken: string;
  dbPath: string;
  publicBaseUrl?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  return {
    port: parsed.PORT,
    adminToken: parsed.ADMIN_TOKEN,
    dbPath: parsed.DB_PATH,
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    logLevel: parsed.LOG_LEVEL,
  };
}
