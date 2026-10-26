import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeChildOutputSchema } from '@ai-smash/protocol';
import type { BridgeChildOutput } from '@ai-smash/protocol';

export interface ChildEvents {
  onOutput(frame: BridgeChildOutput | null, raw: string): void;
  onCrash(): void;
  onFatal(): void;
}

export interface ChildOptions {
  maxRestarts?: number;
  windowMs?: number;
  baseDelayMs?: number;
}

export class ChildRunner {
  private child: ChildProcess | null = null;
  private restartTimes: number[] = [];
  private stopped = false;
  private readonly maxRestarts: number;
  private readonly windowMs: number;
  private readonly baseDelayMs: number;

  constructor(
    private command: string[],
    private events: ChildEvents,
    opts: ChildOptions = {},
  ) {
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
  }

  start(): void {
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    killer.unref?.();
  }

  sendEvent(payload: unknown): void {
    this.child?.stdin?.write(JSON.stringify(payload) + '\n');
  }

  private spawnChild(): void {
    const child = spawn(this.command[0], this.command.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'], // stderr 只到本地（规格 7.2）
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.events.onOutput(null, trimmed);
        return;
      }
      const result = BridgeChildOutputSchema.safeParse(parsed);
      if (!result.success) {
        this.events.onOutput(null, trimmed);
        return;
      }
      this.events.onOutput(result.data, trimmed);
    });
    child.on('exit', () => {
      if (this.stopped) return;
      this.events.onCrash();
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => t > now - this.windowMs);
      this.restartTimes.push(now);
      if (this.restartTimes.length > this.maxRestarts) {
        this.stopped = true;
        this.events.onFatal();
        return;
      }
      const delay = Math.min(this.baseDelayMs * 2 ** (this.restartTimes.length - 1), 16_000);
      const timer = setTimeout(() => {
        if (!this.stopped) this.spawnChild();
      }, delay);
      timer.unref?.();
    });
  }
}
