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
  const actions: HubActions = {
    startApproved: (path, approved, outline) => { const j: Job = { id: `research:${path}`, kind: "research", path, approved, done: [], summary: outline.summary }; added.push(j); queue.add(j); },
    cancelJob: (k, p) => queue.cancelJob(k, p),
    retry: (p) => { void flow.researchFolder(p); },
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
    v, hub, queue, flow, calls, notices, spinners, statuses, reviews, persisted, added, flowNotices,
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
