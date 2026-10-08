import type { Job } from "../types";
import { delayFor, isRetryable } from "./backoff";

export class ApiError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type Runner = (
  job: Job,
  signal: { cancelled: boolean },
  checkpoint: (j: Job) => Promise<void>,
) => Promise<void>;

export interface QueueOpts {
  maxConcurrent: () => number;
  maxRetries: () => number;
  persist: (jobs: Job[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  onChange: (running: number, queued: number) => void;
  onFailed: (job: Job, err: unknown) => void;
  onPersistError?: (err: unknown) => void;
}

interface Active { job: Job; signal: { cancelled: boolean }; wake?: () => void; }

const keyOf = (j: Job) => `${j.kind}\u0000${j.path}`;

export class JobQueue {
  private queue: Job[] = [];
  private running = new Set<Active>();
  private idleWaiters: Array<() => void> = [];
  private persistChain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private run: Runner, private opts: QueueOpts) {}

  add(job: Job): boolean {
    if (this.stopped) return false;
    const k = keyOf(job);
    if (this.queue.some((j) => keyOf(j) === k)) return false;
    for (const a of this.running) if (!a.signal.cancelled && keyOf(a.job) === k) return false;
    this.queue.push(job);
    this.changed();
    this.pump();
    return true;
  }

  restore(jobs: Job[]): void {
    if (this.stopped) return;
    let added = false;
    for (const job of jobs) {
      const k = keyOf(job);
      if (this.queue.some((j) => keyOf(j) === k)) continue;
      let dup = false;
      for (const a of this.running) if (!a.signal.cancelled && keyOf(a.job) === k) dup = true;
      if (dup) continue;
      this.queue.push(job);
      added = true;
    }
    if (added) { this.changed(); this.pump(); }
  }

  cancelAll(): void {
    this.queue = [];
    for (const a of this.running) { a.signal.cancelled = true; a.wake?.(); }
    this.changed();
    this.checkIdle();
  }

  /** Stop without persisting, so the last saved snapshot stays as the resume list. */
  shutdown(): void {
    this.stopped = true;
    this.queue = [];
    for (const a of this.running) { a.signal.cancelled = true; a.wake?.(); }
  }

  idle(): Promise<void> {
    if (this.isIdle()) return this.persistChain;
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && this.running.size === 0;
  }

  private snapshot(): Job[] {
    const live: Job[] = [];
    for (const a of this.running) if (!a.signal.cancelled) live.push(a.job);
    return [...live, ...this.queue];
  }

  private persistNow(): Promise<void> {
    if (this.stopped) return this.persistChain;
    const jobs = this.snapshot();
    this.persistChain = this.persistChain
      .then(() => this.opts.persist(jobs))
      .catch((e) => { try { this.opts.onPersistError?.(e); } catch { /* ignore */ } });
    return this.persistChain;
  }

  private changed(): Promise<void> {
    try { this.opts.onChange(this.running.size, this.queue.length); } catch { /* ignore */ }
    return this.persistNow();
  }

  private checkIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    if (waiters.length) this.persistChain.then(() => waiters.forEach((w) => w()));
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.queue.length > 0 && this.running.size < Math.max(1, this.opts.maxConcurrent())) {
      const job = this.queue.shift()!;
      const active: Active = { job, signal: { cancelled: false } };
      this.running.add(active);
      this.changed();
      this.runJob(active).catch(() => {});
    }
  }

  private async runJob(active: Active): Promise<void> {
    const checkpoint = async (j: Job) => {
      if (this.running.has(active)) active.job = j;
      await this.changed();
    };
    let attempt = 0;
    try {
      for (;;) {
        attempt++;
        try {
          await this.run(active.job, active.signal, checkpoint);
          break;
        } catch (err) {
          if (active.signal.cancelled) break;
          if (isRetryable(err) && attempt <= this.opts.maxRetries()) {
            const retryAfter = err instanceof ApiError ? err.retryAfterMs : undefined;
            await Promise.race([
              this.opts.sleep(delayFor(attempt, retryAfter, this.opts.rand)),
              new Promise<void>((res) => { active.wake = res; if (active.signal.cancelled) res(); }),
            ]);
            active.wake = undefined;
            if (active.signal.cancelled) break;
            continue;
          }
          try { this.opts.onFailed(active.job, err); } catch { /* ignore */ }
          break;
        }
      }
    } finally {
      this.running.delete(active);
      this.changed();
      this.pump();
      this.checkIdle();
    }
  }
}
