import { test, expect } from "vitest";
import { JobQueue, ApiError, type QueueOpts } from "../src/jobs/queue";
import type { Job } from "../src/types";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const pdfJob = (path: string): Job => ({ id: `id-${path}`, kind: "pdf", path });
const researchJob = (path: string): Job => ({ id: `r-${path}`, kind: "research", path, done: [] });

function opts(o: { maxConcurrent?: number; maxRetries?: number } = {}) {
  const persisted: Job[][] = [];
  const sleeps: number[] = [];
  const failed: Array<{ job: Job; err: unknown }> = [];
  const q: QueueOpts = {
    maxConcurrent: () => o.maxConcurrent ?? 2,
    maxRetries: () => o.maxRetries ?? 4,
    persist: async (jobs) => { persisted.push(jobs.map((j) => ({ ...j }))); },
    sleep: async (ms) => { sleeps.push(ms); },
    rand: () => 0.5,
    onChange: () => {},
    onFailed: (job, err) => { failed.push({ job, err }); },
  };
  return Object.assign(q, { persisted, sleeps, failed });
}

test("never exceeds concurrency", async () => {
  let live = 0, peak = 0;
  const q = new JobQueue(async () => { live++; peak = Math.max(peak, live); await tick(); live--; }, opts({ maxConcurrent: 2 }));
  for (let i = 0; i < 20; i++) q.add(pdfJob(`p${i}.pdf`));
  await q.idle();
  expect(peak).toBe(2);
});

test("is FIFO", async () => {
  const order: string[] = [];
  const q = new JobQueue(async (j) => { order.push(j.path); await tick(); }, opts({ maxConcurrent: 1 }));
  for (let i = 0; i < 5; i++) q.add(pdfJob(`p${i}.pdf`));
  await q.idle();
  expect(order).toEqual(["p0.pdf", "p1.pdf", "p2.pdf", "p3.pdf", "p4.pdf"]);
});

test("dedupes same kind+path", async () => {
  const q = new JobQueue(async () => { await tick(); }, opts({ maxConcurrent: 1 }));
  expect(q.add(pdfJob("a.pdf"))).toBe(true);
  expect(q.add({ ...pdfJob("a.pdf"), id: "other" })).toBe(false); // running
  expect(q.add(pdfJob("b.pdf"))).toBe(true);
  expect(q.add({ ...pdfJob("b.pdf"), id: "other2" })).toBe(false); // queued
  expect(q.add(researchJob("a.pdf"))).toBe(true); // different kind
  await q.idle();
});

test("honours retry-after", async () => {
  const o = opts();
  let calls = 0;
  const q = new JobQueue(async () => {
    calls++;
    if (calls === 1) throw new ApiError("slow down", 429, 5000);
  }, o);
  q.add(pdfJob("a.pdf"));
  await q.idle();
  expect(calls).toBe(2);
  expect(o.sleeps).toEqual([5000]);
  expect(o.failed).toHaveLength(0);
});

test("gives up after maxRetries and continues others", async () => {
  const o = opts({ maxRetries: 4, maxConcurrent: 1 });
  const attempts: Record<string, number> = {};
  const done: string[] = [];
  const q = new JobQueue(async (j) => {
    attempts[j.path] = (attempts[j.path] ?? 0) + 1;
    if (j.path === "A.pdf") throw new ApiError("overloaded", 503);
    done.push(j.path);
  }, o);
  q.add(pdfJob("A.pdf"));
  q.add(pdfJob("B.pdf"));
  await q.idle();
  expect(attempts["A.pdf"]).toBe(5);
  expect(o.sleeps).toHaveLength(4);
  expect(o.failed).toHaveLength(1);
  expect(o.failed[0].job.path).toBe("A.pdf");
  expect(done).toEqual(["B.pdf"]);
});

test("non-retryable fails immediately", async () => {
  const o = opts();
  let calls = 0;
  const q = new JobQueue(async () => { calls++; throw new ApiError("unauthorized", 401); }, o);
  q.add(pdfJob("a.pdf"));
  await q.idle();
  expect(calls).toBe(1);
  expect(o.sleeps).toHaveLength(0);
  expect(o.failed).toHaveLength(1);
});

test("persists on every change and restores", async () => {
  const o = opts({ maxConcurrent: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new JobQueue(async () => { await gate; }, o);
  q.add(pdfJob("a.pdf"));
  q.add(pdfJob("b.pdf"));
  await tick();
  const last = o.persisted[o.persisted.length - 1];
  expect(last.map((j) => j.path).sort()).toEqual(["a.pdf", "b.pdf"]); // running + queued
  const saved = last;
  release();
  await q.idle();
  expect(o.persisted[o.persisted.length - 1]).toEqual([]); // completed drop out

  const ran: string[] = [];
  const q2 = new JobQueue(async (j) => { ran.push(j.path); }, opts());
  q2.restore(saved);
  await q2.idle();
  expect(ran.sort()).toEqual(["a.pdf", "b.pdf"]);
});

test("checkpoint persists updated job state", async () => {
  const o = opts();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new JobQueue(async (job, _s, checkpoint) => {
    await checkpoint({ ...(job as any), done: ["A"] });
    await gate;
  }, o);
  q.add(researchJob("topic"));
  await tick();
  const last = o.persisted[o.persisted.length - 1];
  expect(last).toHaveLength(1);
  expect((last[0] as any).done).toEqual(["A"]);
  release();
  await q.idle();
});

test("cancelAll empties queue and flags running", async () => {
  const o = opts({ maxConcurrent: 1 });
  const ran: string[] = [];
  let sawCancel = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new JobQueue(async (j, signal) => {
    ran.push(j.path);
    await gate;
    sawCancel = signal.cancelled;
    throw new ApiError("overloaded", 503); // must not be retried after cancel
  }, o);
  q.add(pdfJob("a.pdf"));
  q.add(pdfJob("b.pdf"));
  await tick();
  q.cancelAll();
  release();
  await q.idle();
  expect(ran).toEqual(["a.pdf"]);
  expect(sawCancel).toBe(true);
  expect(o.sleeps).toHaveLength(0);
  expect(o.failed).toHaveLength(0);
  expect(o.persisted[o.persisted.length - 1]).toEqual([]);
});

test("add after cancelAll allows same kind+path again", async () => {
  const o = opts({ maxConcurrent: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let runs = 0;
  const q = new JobQueue(async () => { runs++; if (runs === 1) await gate; }, o);
  q.add(pdfJob("a.pdf"));
  await tick();
  q.cancelAll();
  expect(q.add(pdfJob("a.pdf"))).toBe(true);
  release();
  await q.idle();
  expect(runs).toBe(2);
});

test("cancelAll wakes a sleeping retry and frees the slot", async () => {
  const o = opts({ maxConcurrent: 1 });
  o.sleep = () => new Promise<void>(() => {});
  let runs = 0;
  const q = new JobQueue(async () => { runs++; throw new ApiError("slow", 429, 60000); }, o);
  q.add(pdfJob("a.pdf"));
  await tick();
  q.cancelAll();
  await q.idle();
  expect(runs).toBe(1);
  expect(o.failed).toHaveLength(0);
});

test("throwing onFailed and onChange never leak a slot", async () => {
  const o = opts({ maxConcurrent: 1 });
  o.onFailed = () => { throw new Error("cb"); };
  o.onChange = () => { throw new Error("cb2"); };
  const done: string[] = [];
  const q = new JobQueue(async (j) => {
    if (j.path === "a.pdf") throw new ApiError("no", 401);
    done.push(j.path);
  }, o);
  q.add(pdfJob("a.pdf"));
  q.add(pdfJob("b.pdf"));
  await q.idle();
  expect(done).toEqual(["b.pdf"]);
});

test("onPersistError is called when persist rejects", async () => {
  const o = opts();
  const errs: unknown[] = [];
  o.persist = async () => { throw new Error("disk"); };
  (o as QueueOpts).onPersistError = (e) => { errs.push(e); };
  const q = new JobQueue(async () => {}, o);
  q.add(pdfJob("a.pdf"));
  await q.idle();
  expect(errs.length).toBeGreaterThan(0);
});

test("50-add burst with sync-throwing and rejecting runners respects concurrency", async () => {
  const o = opts({ maxConcurrent: 3 });
  let live = 0, peak = 0, finished = 0;
  const q = new JobQueue(async (j) => {
    live++; peak = Math.max(peak, live);
    try {
      const n = Number(j.path.slice(1, -4));
      if (n % 3 === 0) throw new ApiError("no", 400);
      if (n % 3 === 1) await Promise.reject(new ApiError("no", 401));
      await tick();
    } finally { live--; finished++; }
  }, o);
  for (let i = 0; i < 50; i++) q.add(pdfJob(`p${i}.pdf`));
  await q.idle();
  expect(peak).toBeLessThanOrEqual(3);
  expect(finished).toBe(50);
});

test("429 storm: one job gives up, the rest finish", async () => {
  const o = opts({ maxConcurrent: 3, maxRetries: 2 });
  const done: string[] = [];
  const calls: Record<string, number> = {};
  const q = new JobQueue(async (j) => {
    calls[j.path] = (calls[j.path] ?? 0) + 1;
    if (j.path === "bad.pdf") throw new ApiError("rl", 429);
    if (calls[j.path] < 2) throw new ApiError("rl", 429, 100);
    done.push(j.path);
  }, o);
  for (const p of ["a.pdf", "bad.pdf", "b.pdf", "c.pdf"]) q.add(pdfJob(p));
  await q.idle();
  expect(done.sort()).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
  expect(calls["bad.pdf"]).toBe(3);
  expect(o.failed.map((f) => f.job.path)).toEqual(["bad.pdf"]);
});

test("restore dedupes against running; idle can be called repeatedly", async () => {
  const o = opts({ maxConcurrent: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let runs = 0;
  const q = new JobQueue(async () => { runs++; await gate; }, o);
  q.add(pdfJob("a.pdf"));
  await tick();
  q.restore([pdfJob("a.pdf"), pdfJob("b.pdf")]);
  const i1 = q.idle(), i2 = q.idle();
  release();
  await Promise.all([i1, i2]);
  await q.idle();
  await q.idle();
  expect(runs).toBe(2);
});

test("restore after an early add keeps both and persists both", async () => {
  const o = opts({ maxConcurrent: 1 });
  const runs: string[] = [];
  const q = new JobQueue(async (j) => { runs.push(j.path); await tick(); }, o);
  q.add(pdfJob("A.pdf"));
  q.restore([pdfJob("B.pdf"), pdfJob("A.pdf")]);
  await tick();
  expect(o.persisted.some((p) => p.map((j) => j.path).sort().join() === "A.pdf,B.pdf")).toBe(true);
  await q.idle();
  expect(runs.sort()).toEqual(["A.pdf", "B.pdf"]);
});

test("shutdown cancels running, drops queued, and never persists again", async () => {
  const o = opts({ maxConcurrent: 1 });
  const seen: boolean[] = [];
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new JobQueue(async (j, signal, checkpoint) => {
    ran.push(j.path);
    await gate;
    seen.push(signal.cancelled);
    await checkpoint(j);
  }, o);
  q.add(pdfJob("a.pdf"));
  q.add(pdfJob("b.pdf"));
  await tick();
  const before = o.persisted.length;
  q.shutdown();
  release();
  await tick(); await tick();
  expect(seen).toEqual([true]);
  expect(ran).toEqual(["a.pdf"]);
  expect(o.persisted.length).toBe(before);
  expect(q.add(pdfJob("c.pdf"))).toBe(false);
});

test("shutdown wakes a job sleeping between retries", async () => {
  const o = opts({ maxConcurrent: 1 });
  o.sleep = () => new Promise<void>(() => {}); // never resolves
  let calls = 0;
  const q = new JobQueue(async () => { calls++; throw new ApiError("x", 429); }, o);
  q.add(pdfJob("a.pdf"));
  await tick();
  const before = o.persisted.length;
  q.shutdown();
  await tick(); await tick();
  expect(calls).toBe(1);
  expect(o.persisted.length).toBe(before);
  expect(o.failed).toEqual([]);
});

test("cancelJob removes a queued job and persists without it; returns true", async () => {
  const o = opts({ maxConcurrent: 1 });
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new JobQueue(async (j) => { ran.push(j.path); await gate; }, o);
  q.add(pdfJob("a.pdf"));
  q.add(pdfJob("b.pdf"));
  await tick();
  expect(q.cancelJob("pdf", "b.pdf")).toBe(true);
  await tick();
  expect(o.persisted[o.persisted.length - 1].map((j) => j.path)).toEqual(["a.pdf"]);
  release();
  await q.idle();
  expect(ran).toEqual(["a.pdf"]);
});

test("cancelJob flags a running job, wakes a sleeping retry, and the job is not retried or persisted", async () => {
  const o = opts({ maxConcurrent: 2 });
  o.sleep = () => new Promise<void>(() => {}); // never resolves
  let runs = 0;
  const seen: boolean[] = [];
  const q = new JobQueue(async (j, signal) => {
    if (j.path === "a.pdf") { runs++; seen.push(signal.cancelled); throw new ApiError("slow", 429); }
    await tick();
  }, o);
  q.add(pdfJob("a.pdf"));
  await tick();
  expect(q.cancelJob("pdf", "a.pdf")).toBe(true);
  await q.idle();
  expect(runs).toBe(1);
  expect(o.failed).toHaveLength(0);
  expect(o.persisted[o.persisted.length - 1]).toEqual([]);
  expect(q.cancelJob("pdf", "a.pdf")).toBe(false);
});

test("cancelJob returns false for an unknown job", async () => {
  const q = new JobQueue(async () => {}, opts());
  expect(q.cancelJob("pdf", "nope.pdf")).toBe(false);
  q.add(pdfJob("a.pdf"));
  expect(q.cancelJob("research", "a.pdf")).toBe(false); // different kind
  await q.idle();
  q.shutdown();
  expect(q.cancelJob("pdf", "a.pdf")).toBe(false);
});
