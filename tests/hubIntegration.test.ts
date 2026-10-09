import { beforeEach, expect, test } from "vitest";
import { ProgressHub } from "../src/ui/hub";
import type { HubActions, HubUi, PendingReview } from "../src/ui/hub";
import { ResearchFlow, type ResearchDeps } from "../src/flows/researchFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { JobQueue } from "../src/jobs/queue";
import { resetRunIds } from "../src/progress";
import type { Job, NoteContent, Outline, SubfolderSuggestion } from "../src/types";
import type { Settings } from "../src/settings";

// Real ResearchFlow + real JobQueue + real ProgressHub; only the client, the vault and the UI are fakes.

class MemVault implements VaultLike {
  files = new Map<string, string>();
  folders = new Set<string>();
  exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async read(p: string) {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("no file " + p);
    return c;
  }
  async createFolder(p: string) { if (this.exists(p)) throw new Error("exists " + p); this.folders.add(p); }
  async createFile(p: string, c: string) { if (this.exists(p)) throw new Error("exists " + p); this.files.set(p, c); }
  children(p: string) {
    const out: { name: string; isFolder: boolean }[] = [];
    const pre = p === "" ? "" : p + "/";
    for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: false });
    for (const f of this.folders) if (f.startsWith(pre) && f !== p && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: true });
    return out;
  }
}

const sug = (name: string): SubfolderSuggestion => ({ name, why: "w" });
const A = sug("A"), B = sug("B"), C = sug("C");
const note = (title: string): NoteContent => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const settings: Settings = {
  apiKey: "key", model: "m", modelChosen: false, useWebSearch: false, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 6, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 1, maxRetries: 0,
  processPdfs: false, pdfPagesPerChunk: 20, confirmAbovePages: 100,
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const T = "T";

function world() {
  const v = new MemVault();
  v.folders.add(T);
  const writer = new VaultWriter(v);
  const calls = { outline: 0, notes: [] as string[] };
  const client = {
    async outline(topic: string): Promise<Outline> { calls.outline++; return { topic, summary: "sum", subfolders: [A, B, C] }; },
    async notes(_t: string, _p: string[], s: SubfolderSuggestion) { calls.notes.push(s.name); return [note(`${s.name} note`)]; },
    async extractPdf(): Promise<never> { throw new Error("unused"); },
  };
  const notices: { text: string; error: boolean; action?: { label: string; run: () => void } }[] = [];
  const spinners: string[][] = [];
  const statuses: string[] = [];
  const reviews: { outline: Outline; resolve: (v: SubfolderSuggestion[] | null) => void }[] = [];
  const persisted: PendingReview[][] = [];
  const flowNotices: string[] = [];
  const ui: HubUi = {
    notice: (text, opts) => { notices.push({ text, error: !!opts?.error, action: opts?.action }); },
    setStatus: (t) => { statuses.push(t); },
    setSpinners: (p) => { spinners.push([...p]); },
    reviewModal: (outline) => new Promise((resolve) => { reviews.push({ outline, resolve }); }),
  };
  // eslint-disable-next-line prefer-const
  let queue: JobQueue;
  // eslint-disable-next-line prefer-const
  let flow: ResearchFlow;
  const added: Job[] = [];
  const attempts: string[] = [];
  const actions: HubActions = {
    // Mirrors main.ts: the job is recorded in `added` only when the queue accepted it.
    startApproved: (path, approved, outline) => {
      attempts.push(path);
      const j: Job = { id: `research:${path}`, kind: "research", path, approved, done: [], summary: outline.summary };
      const ok = queue.add(j);
      if (ok) added.push(j);
      return ok;
    },
    pathExists: (p) => v.folders.has(p),
    cancelAllJobs: () => { queue.cancelAll(); flow.endRun(); },
    persistPending: (l) => { persisted.push(l.map((x) => ({ ...x }))); },
  };
  const hub = new ProgressHub(ui, actions);
  queue = new JobQueue((job, signal, cp) => flow.run(job, signal, cp), {
    maxConcurrent: () => 1, maxRetries: () => 0,
    persist: async () => {}, sleep: async () => {}, rand: () => 0.5,
    onChange: (r, q) => hub.onQueueChange(r, q),
    onFailed: (job, err) => hub.onQueueFailed(job, err),
  });
  const deps: ResearchDeps = {
    client: () => client,
    writer,
    notify: { info: (m) => flowNotices.push(m), error: (m) => flowNotices.push(m) },
    rename: async () => {},
    settings: () => settings,
    today: () => "2026-10-09",
    enqueue: (j) => queue.add(j),
    listPdfs: () => [],
    queuePdfs: async () => {},
    progress: hub.sink,
  };
  flow = new ResearchFlow(deps);
  flow.markReady();
  return {
    v, hub, queue, flow, calls, notices, spinners, statuses, reviews, persisted, added, attempts, flowNotices,
    spin: () => (spinners.length ? spinners[spinners.length - 1] : []),
    status: () => (statuses.length ? statuses[statuses.length - 1] : ""),
    /** Runs a fresh research job for T until its outline is pending. */
    async outline() { await flow.researchFolder(T, { force: true }); await queue.idle(); },
  };
}

beforeEach(() => resetRunIds());

test("outline -> hub pending + Review notice -> Create runs the approved job and writes only the approved subfolders", async () => {
  const w = world();
  await w.outline();
  expect(w.calls.outline).toBe(1);
  expect(w.calls.notes).toEqual([]);
  expect([...w.v.files.keys()]).toEqual([]);
  expect(w.hub.pending()).toEqual([{ path: T, outline: { topic: T, summary: "sum", subfolders: [A, B, C] } }]);
  expect(w.persisted.at(-1)).toEqual(w.hub.pending());
  expect(w.notices.map((n) => n.text)).toEqual(["Suggestions ready for T"]);
  expect(w.notices[0].action?.label).toBe("Review");
  expect(w.spin()).toEqual([T]);
  expect(w.status()).toBe("Suggestions ready (1)");
  expect(w.reviews).toHaveLength(0); // nothing opens by itself

  w.notices[0].action!.run();
  expect(w.reviews).toHaveLength(1);
  w.reviews[0].resolve([A, C]);
  await flush();
  await w.queue.idle();
  expect(w.added).toEqual([{ id: `research:${T}`, kind: "research", path: T, approved: [A, C], done: [], summary: "sum" }]);
  expect(w.calls.outline).toBe(1);
  expect(w.calls.notes).toEqual(["A", "C"]);
  expect(w.v.files.has("T/A/A note.md")).toBe(true);
  expect(w.v.files.has("T/C/C note.md")).toBe(true);
  expect(w.v.folders.has("T/B")).toBe(false);
  expect(w.v.files.get("T/T - Overview.md")).toContain("> sum");
  expect(w.notices.at(-1)).toEqual({ text: "Researched T: 2 folders, 2 notes", error: false, action: undefined });
  expect(w.notices.filter((n) => n.error)).toEqual([]);
  expect(w.hub.pending()).toEqual([]);
  expect(w.persisted.at(-1)).toEqual([]);
  expect(w.spin()).toEqual([]);
  expect(w.status()).toBe("");
  expect(w.flowNotices).toEqual([]);
});

test("review modal closed (null) -> nothing enqueued, pending removed", async () => {
  const w = world();
  await w.outline();
  expect(w.notices.filter((n) => n.error)).toEqual([]);
  const p = w.hub.review();
  w.reviews[0].resolve(null);
  await p;
  await w.queue.idle();
  expect(w.added).toEqual([]);
  expect(w.calls.notes).toEqual([]);
  expect([...w.v.files.keys()]).toEqual([]);
  expect(w.hub.pending()).toEqual([]);
  expect(w.persisted.at(-1)).toEqual([]);
});

// Item 5: closing the suggestion modal cancels the job (real flow + queue + hub).
test("closing the suggestion modal cancels: no job, no writes, spinner cleared, neutral notice; a second review of the path does nothing", async () => {
  const w = world();
  await w.outline();
  expect(w.spin()).toEqual([T]);
  w.notices[0].action!.run();
  w.reviews[0].resolve(null);
  await flush();
  await w.queue.idle();
  expect(w.added).toEqual([]);
  expect(w.calls.outline).toBe(1);
  expect(w.calls.notes).toEqual([]);
  expect([...w.v.files.keys()]).toEqual([]);
  expect([...w.v.folders]).toEqual([T]);
  expect(w.spin()).toEqual([]);
  expect(w.status()).toBe("");
  expect(w.notices.at(-1)).toEqual({ text: "Cancelled", error: false, action: undefined });
  expect(w.notices.filter((n) => n.error)).toEqual([]);
  expect(w.hub.pending()).toEqual([]);
  expect(w.persisted.at(-1)).toEqual([]);
  // The old notice's Review button and the command both find nothing to review.
  const before = w.notices.length;
  w.notices[0].action!.run();
  await w.hub.review(T);
  await flush();
  await w.queue.idle();
  expect(w.reviews).toHaveLength(1);
  expect(w.added).toEqual([]);
  expect(w.notices.slice(before).map((n) => n.text)).toEqual(["No suggestions are waiting for review.", "No suggestions are waiting for review."]);
  expect(w.spin()).toEqual([]);
});

test("Cancel all while the suggestion modal is open: its later Create is ignored (no job, no writes)", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  expect(w.reviews).toHaveLength(1);
  // What the command does.
  w.queue.cancelAll();
  w.flow.endRun();
  w.hub.cancelAll();
  w.reviews[0].resolve([A]);
  await p;
  await w.queue.idle();
  expect(w.added).toEqual([]);
  expect(w.calls.notes).toEqual([]);
  expect([...w.v.files.keys()]).toEqual([]);
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
  expect(w.notices.at(-1)!.text).toBe("Cancelled all research jobs.");
});

test("re-running the folder while its review is open: the outdated modal's result is ignored and the new suggestions stay pending", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  await w.outline(); // a second outline run for the same folder replaces the pending suggestions
  expect(w.calls.outline).toBe(2);
  expect(w.notices.filter((n) => n.text === "Suggestions ready for T")).toHaveLength(2);
  w.reviews[0].resolve([A]);
  await p;
  await w.queue.idle();
  expect(w.added).toEqual([]);
  expect(w.calls.notes).toEqual([]);
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toEqual([T]);
  // Closing the new review cancels it.
  const q = w.hub.review(T);
  expect(w.reviews).toHaveLength(2);
  w.reviews[1].resolve(null);
  await q;
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
  expect(w.notices.at(-1)!.text).toBe("Cancelled");
});

test("closing an outdated modal while the re-run for the same folder is queued keeps its spinner", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const real = w.flow.run;
  (w.flow as any).run = async (job: Job, signal: { cancelled: boolean }, cp: (j: Job) => Promise<void>) => {
    if (job.path === "U") { await hold; return; }
    return real(job, signal, cp);
  };
  w.v.folders.add("U");
  w.queue.add({ id: "research:U", kind: "research", path: "U", done: [] });
  await w.flow.researchFolder(T, { force: true });
  w.reviews[0].resolve(null);
  await p;
  expect(w.notices.at(-1)!.text).toBe("Cancelled");
  expect(w.spin()).toContain(T); // T's re-run is still waiting in the queue
  release();
  await w.queue.idle();
  // The queued re-run still ran and produced fresh suggestions.
  expect(w.calls.outline).toBe(2);
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toEqual([T]);
});

test("closing an outdated modal while the re-run for the same folder is running: the re-run's suggestions still arrive", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const client = (w.flow as any).deps.client();
  const realOutline = client.outline.bind(client);
  client.outline = async (topic: string) => { await hold; return realOutline(topic); };
  (w.flow as any).deps.client = () => client;
  await w.flow.researchFolder(T, { force: true });
  await flush(); // the re-run has started and is waiting for its outline
  w.reviews[0].resolve(null);
  await p;
  expect(w.spin()).toEqual([T]);
  release();
  await w.queue.idle();
  expect(w.calls.outline).toBe(2);
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.notices.filter((n) => n.text === "Suggestions ready for T")).toHaveLength(2);
  expect(w.spin()).toEqual([T]);
});

// Fix round 1.
const BUSY = "T is already being researched — review again when it finishes.";

test("I1: Create while a newer run of the folder is running: no job is lost; the choice stays pending and the newer outline becomes the pending review", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const client = (w.flow as any).deps.client();
  const realOutline = client.outline.bind(client);
  client.outline = async (topic: string) => { await hold; return realOutline(topic); };
  (w.flow as any).deps.client = () => client;
  await w.flow.researchFolder(T, { force: true });
  await flush(); // the re-run is running, waiting for its outline
  w.reviews[0].resolve([A]);
  await p;
  expect(w.attempts).toEqual([T]);
  expect(w.added).toEqual([]);
  expect(w.notices.at(-1)).toEqual({ text: BUSY, error: false, action: undefined });
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toEqual([T]);
  release();
  await w.queue.idle();
  expect(w.calls.outline).toBe(2);
  expect(w.notices.filter((n) => n.text === "Suggestions ready for T")).toHaveLength(2);
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toEqual([T]);
  expect(w.calls.notes).toEqual([]);
});

test("I1: Create while a newer run of the folder is only queued: same outcome", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const real = w.flow.run;
  (w.flow as any).run = async (job: Job, signal: { cancelled: boolean }, cp: (j: Job) => Promise<void>) => {
    if (job.path === "U") { await hold; return; }
    return real(job, signal, cp);
  };
  w.v.folders.add("U");
  w.queue.add({ id: "research:U", kind: "research", path: "U", done: [] });
  await w.flow.researchFolder(T, { force: true });
  w.reviews[0].resolve([A]);
  await p;
  expect(w.added).toEqual([]);
  expect(w.notices.at(-1)).toEqual({ text: BUSY, error: false, action: undefined });
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toContain(T);
  release();
  await w.queue.idle();
  expect(w.calls.outline).toBe(2);
  expect(w.hub.pending()).toHaveLength(1);
  expect(w.spin()).toEqual([T]);
  expect(w.calls.notes).toEqual([]);
});

test("I2: a pending review whose folder was deleted: Review opens no modal and nothing is written or requested", async () => {
  const w = world();
  await w.outline();
  w.v.folders.delete(T);
  await w.hub.review(T);
  await w.queue.idle();
  expect(w.reviews).toHaveLength(0);
  expect(w.attempts).toEqual([]);
  expect(w.v.folders.has(T)).toBe(false);
  expect(w.calls.notes).toEqual([]);
  expect(w.notices.at(-1)!.text).toBe("T no longer exists, nothing was started.");
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
});

test("restart: a saved pending review is restored without a new outline request or modal; Review -> Create runs the approved job", async () => {
  const w = world();
  const saved = [{ path: T, outline: { topic: T, summary: "saved", subfolders: [A, B] } }];
  w.hub.restorePending(saved, []);
  w.queue.restore([]);
  await w.queue.idle();
  expect(w.calls.outline).toBe(0);
  expect(w.reviews).toHaveLength(0);
  expect(w.notices.map((n) => n.text)).toEqual(["Suggestions ready for T"]);
  expect(w.spin()).toEqual([T]);
  w.notices[0].action!.run();
  expect(w.reviews).toHaveLength(1);
  w.reviews[0].resolve([B]);
  await flush();
  await w.queue.idle();
  expect(w.calls.outline).toBe(0);
  expect(w.calls.notes).toEqual(["B"]);
  expect(w.v.files.get("T/T - Overview.md")).toContain("> saved");
  expect(w.notices.at(-1)!.text).toBe("Researched T: 1 folder, 1 note");
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
});

// Item 3.
test("status after Create reads 'Researching T…' (never 'Resuming research…') and ends empty", async () => {
  const w = world();
  await w.outline();
  const p = w.hub.review(T);
  w.reviews[0].resolve([A]);
  await p;
  await w.queue.idle();
  const after = w.statuses.slice(w.statuses.indexOf("Suggestions ready (1)"));
  expect(after).toContain("Researching T…");
  expect(w.statuses.some((s) => s.startsWith("Resuming"))).toBe(false);
  expect(w.status()).toBe("");
});

test("status bar menu 'Cancel all' stops the running job in the real queue", async () => {
  const w = world();
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const client = (w.flow as any).deps.client();
  const realOutline = client.outline.bind(client);
  client.outline = async (topic: string) => { await hold; return realOutline(topic); };
  const flowEvents: string[] = [];
  const sink = (w.flow as any).deps.progress;
  (w.flow as any).deps.progress = (p: string, e: any, s: any) => { flowEvents.push(e.kind === "failed" ? `failed:${e.error}` : e.kind); sink(p, e, s); };
  (w.flow as any).deps.client = () => client;
  await w.flow.researchFolder(T, { force: true });
  await flush();
  const cancel = w.hub.menuItems().find((m) => m.label === "Cancel all research jobs")!;
  cancel.run();
  release();
  await w.queue.idle();
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
  expect(w.status()).toBe("");
  expect(w.notices.map((n) => n.text)).toEqual(["Cancelled all research jobs."]);
  expect(flowEvents.at(-1)).toBe("failed:Cancelled"); // the queue signalled the job, so it stopped instead of delivering an outline
  expect(flowEvents).not.toContain("outline");
});

// Item 14: cancelling or reusing restored state leaves nothing stale.
const savedReview = (path = T) => [{ path, outline: { topic: path, summary: "saved", subfolders: [A, B] } }];

test("item 14 (1): restored pending review, then Cancel all: spinner cleared, persisted list empty; re-triggering the folder is accepted and shows its normal notices", async () => {
  const w = world();
  w.hub.restorePending(savedReview(), []);
  w.hub.cancelEverything();
  await w.queue.idle();
  expect(w.spin()).toEqual([]);
  expect(w.status()).toBe("");
  expect(w.persisted.at(-1)).toEqual([]);
  expect(w.hub.pending()).toEqual([]);
  const n = w.notices.length;
  await w.outline();
  expect(w.calls.outline).toBe(1);
  expect(w.notices.slice(n).map((x) => x.text)).toEqual(["Suggestions ready for T"]);
  expect(w.spin()).toEqual([T]);
  const p = w.hub.review(T);
  w.reviews[0].resolve([A]);
  await p;
  await w.queue.idle();
  expect(w.notices.at(-1)!.text).toBe("Researched T: 1 folder, 1 note");
  expect(w.spin()).toEqual([]);
});

test("item 14 (2): restored research job (approved) cancelled mid-run: no stale spinner or status; a later trigger on the path works", async () => {
  const w = world();
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const client = (w.flow as any).deps.client();
  const realNotes = client.notes.bind(client);
  let held = true;
  client.notes = async (...a: any[]) => { if (held) await hold; return realNotes(...a); };
  (w.flow as any).deps.client = () => client;
  const job: Job = { id: `research:${T}`, kind: "research", path: T, approved: [A, B], done: ["A"] };
  w.v.folders.add("T/A");
  w.hub.restorePending([], [job]);
  w.queue.restore([job]);
  await flush();
  expect(w.spin()).toEqual([T]);
  expect(w.status()).toBe("Writing folder 2 of 2: B");
  w.hub.cancelEverything();
  held = false;
  release();
  await w.queue.idle();
  expect(w.spin()).toEqual([]);
  expect(w.status()).toBe("");
  expect(w.notices.map((x) => x.text)).toEqual(["Cancelled all research jobs."]);
  expect(w.v.files.has("T/T - Overview.md")).toBe(false);
  // A later trigger on the same path.
  await w.outline();
  expect(w.notices.at(-1)!.text).toBe("Suggestions ready for T");
  expect(w.spin()).toEqual([T]);
  expect(w.status()).toBe("Suggestions ready (1)");
});

test("item 14 (3): a restored job whose run fails at once shows exactly one notice (flow failure, and flow failure + queue give-up)", async () => {
  // No API key: the flow ends the run with a failed event and returns.
  const a = world();
  (a.flow as any).deps.client = () => null;
  const job: Job = { id: `research:${T}`, kind: "research", path: T, approved: [A], done: [] };
  a.hub.restorePending([], [job]);
  a.queue.restore([job]);
  await a.queue.idle();
  expect(a.notices.map((x) => x.text)).toEqual(["Research failed for T: Add your Claude API key in the plugin settings before researching a topic."]);
  expect(a.spin()).toEqual([]);
  // Overview write fails (non-retryable): the flow reports it and rethrows, the queue gives up -> still one notice.
  const b = world();
  (b.v as any).createFile = async (p: string, c: string) => { if (p.endsWith("Overview.md")) throw new Error("disk full"); b.v.files.set(p, c); };
  b.hub.restorePending([], [job]);
  b.queue.restore([job]);
  await b.queue.idle();
  expect(b.notices.map((x) => x.text)).toEqual(["Research failed for T: disk full"]);
  expect(b.spin()).toEqual([]);
  expect(b.status()).toBe("");
});

test("item 14 (4): a restored pending review still works after its folder was renamed", async () => {
  const w = world();
  w.hub.restorePending(savedReview(), []);
  w.v.folders.delete(T);
  w.v.folders.add("Renamed");
  w.hub.renamePending(T, "Renamed");
  expect(w.spin()).toEqual(["Renamed"]);
  expect(w.persisted.at(-1)!.map((x) => x.path)).toEqual(["Renamed"]);
  const p = w.hub.review();
  expect(w.reviews).toHaveLength(1);
  w.reviews[0].resolve([B]);
  await p;
  await w.queue.idle();
  expect(w.v.files.has("Renamed/B/B note.md")).toBe(true);
  expect(w.v.folders.has(T)).toBe(false);
  expect(w.notices.at(-1)!.text).toBe("Researched Renamed: 1 folder, 1 note");
  expect(w.spin()).toEqual([]);
});

test("item 14 (5): Create on a restored pending review runs the approved job and removes the entry from the persisted list", async () => {
  const w = world();
  w.hub.restorePending(savedReview(), []);
  expect(w.persisted).toEqual([]); // restoring does not rewrite data.json
  const p = w.hub.review(T);
  w.reviews[0].resolve([A, B]);
  await p;
  expect(w.persisted.at(-1)).toEqual([]);
  await w.queue.idle();
  expect(w.added).toEqual([{ id: `research:${T}`, kind: "research", path: T, approved: [A, B], done: [], summary: "saved" }]);
  expect(w.calls.notes).toEqual(["A", "B"]);
  expect(w.calls.outline).toBe(0);
  expect(w.hub.pending()).toEqual([]);
  expect(w.spin()).toEqual([]);
});
