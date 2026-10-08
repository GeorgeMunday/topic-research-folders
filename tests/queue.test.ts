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
