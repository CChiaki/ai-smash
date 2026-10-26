import type { Limits } from '@ai-smash/protocol';
import { runScoring } from './engine/score.js';
import type { Storage } from './storage/types.js';

export type ScoringFn = (storage: Storage, now: Date, limits: Limits) => number;

export function startScoringTimer(
  storage: Storage,
  limits: Limits,
  intervalMs = 300_000,
  fn: ScoringFn = runScoring,
): { stop(): void } {
  const timer = setInterval(() => {
    try {
      fn(storage, new Date(), limits);
    } catch {
      // 评分失败不影响主流程
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
