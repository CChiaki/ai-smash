import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScoring } from '../src/engine/score.js';
import { startScoringTimer } from '../src/timer.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { DEFAULT_LIMITS } from '@ai-smash/protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startScoringTimer', () => {
  it('按间隔触发 runScoring，stop 后不再触发', async () => {
    const storage = new SqliteStorage(':memory:');
    const spy = vi.spyOn({ runScoring }, 'runScoring');
    const t = startScoringTimer(storage, DEFAULT_LIMITS, 1000, spy as any);
    await vi.advanceTimersByTimeAsync(2500);
    expect(spy).toHaveBeenCalledTimes(2);
    t.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
