import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { KeypointFlow, type KeypointDeps } from "../src/flows/keypointFlow";
import { PdfFlow } from "../src/flows/pdfFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { ApiError, JobQueue } from "../src/jobs/queue";
import { ClaudeClient, type HttpFn } from "../src/research/claudeClient";
import { ProgressHub } from "../src/ui/hub";
import { CANCELLED_MESSAGE, resetRunIds, type ProgressSource } from "../src/progress";
import type { Job, KeyPoint, NoteContent, PdfOverview, Progress, SubfolderSuggestion } from "../src/types";
import type { Settings } from "../src/settings";

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

const settingsBase: Settings = {
  apiKey: "test-key", model: "m", modelChosen: false, useWebSearch: true, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 5, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 2, maxRetries: 0,
  processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200,
};
const DATE = "2026-10-09";
const noSignal = { cancelled: false };
const noCp = async () => {};
const note = (title: string): NoteContent => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const kp = (name: string, page: number, subfolder?: string): KeyPoint => ({
  name, text: `${name} is central (p. ${page})`, detail: `The paper discusses ${name}.`, pages: String(page), ...(subfolder ? { subfolder } : {}),
});
const NAMES = ["Fusion", "Gravity", "Life cycle", "Supernovae", "Neutron stars"];
const FIVE: PdfOverview = { summary: "About stars.", plainWords: "Stars are hot.", keyPoints: NAMES.map((n, i) => kp(n, i + 2)) };

const kjob = (folder: string, name: string, over: Partial<Job> = {}): Job => ({
  id: `keypoint:${folder}/${name}.md`, kind: "keypoint", path: `${folder}/${name}.md`, folder, pdfName: "paper.pdf",
  topic: "paper", parents: [], docSummary: "A paper about stars.", point: kp(name, 3), ...over,
} as Job);

type Ev = [string, Progress, ProgressSource];

function unit(over: Partial<Settings> = {}) {
  const v = new MemVault();
  const writer = new VaultWriter(v);
  const settings = { ...settingsBase, ...over };
  const notes = vi.fn(async (_t: string, _p: string[], s: SubfolderSuggestion, count: number) =>
    Array.from({ length: count }, (_, i) => note(`${s.name} ${i + 1}`)));
  const client = { v: { notes } as any };
  const events: Ev[] = [];
  const errors: string[] = [];
  const infos: string[] = [];
  const deps: KeypointDeps = {
    client: () => client.v, writer, settings: () => settings, today: () => DATE,
    notify: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
    progress: (p, e, s) => { events.push([p, e, s]); },
  };
  const flow = new KeypointFlow(deps);
  return { v, writer, flow, notes, client, events, errors, infos, deps, kinds: () => events.map((e) => e[1]) };
}

beforeEach(() => resetRunIds());

describe("keypoint run", () => {
  test("writes notesPerSubfolder notes into its folder via client.notes with the PDF context in `why`", async () => {
    const u = unit({ notesPerSubfolder: 4 });
    u.v.folders.add("Stars/Fusion");
    const j = kjob("Stars/Fusion", "Fusion", { parents: ["Space"], topic: "Stars paper" } as Partial<Job>);
    await u.flow.run(j, noSignal, noCp);
    expect(u.notes).toHaveBeenCalledTimes(1);
    expect(u.notes.mock.calls[0]).toEqual([
      "Stars paper", ["Space"],
      { name: "Fusion", why: "Fusion is central (p. 3) — from the PDF \"paper.pdf\" (A paper about stars.): The paper discusses Fusion." },
      4,
    ]);
    for (const i of [1, 2, 3, 4]) expect(u.v.files.get(`Stars/Fusion/Fusion ${i}.md`)).toContain('subtopic: "Fusion"');
    expect(u.v.files.get("Stars/Fusion/Fusion 1.md")).toContain('topic: "Stars paper"');
    expect(u.kinds()).toEqual([
      { kind: "step", text: 'Researching "Fusion" (from paper.pdf)…' },
      { kind: "done", folders: 1, notes: 4 },
    ]);
    // Events are keyed by the key point's entry note path (unique per job) and come from a "keypoint" source with one run id.
    expect(u.events.every(([p, , s]) => p === "Stars/Fusion/Fusion.md" && s.kind === "keypoint" && s.resumed === false)).toBe(true);
    expect(new Set(u.events.map((e) => e[2].runId)).size).toBe(1);
    expect([...u.errors, ...u.infos]).toEqual([]);
  });

  test("a restored job saved before docSummary existed still runs (missing summary treated as empty)", async () => {
    const u = unit();
    u.v.folders.add("F");
    const old = kjob("F", "Fusion") as any;
    delete old.docSummary;
    await u.flow.run(old, noSignal, noCp);
    expect(u.notes.mock.calls[0][2]).toEqual({ name: "Fusion", why: 'Fusion is central (p. 3) — from the PDF "paper.pdf": The paper discusses Fusion.' });
    expect(u.kinds().at(-1)).toEqual({ kind: "done", folders: 1, notes: 3 });
  });

  test("ignores jobs of other kinds", async () => {
    const u = unit();
    await u.flow.run({ id: "pdf:a.pdf", kind: "pdf", path: "a.pdf" }, noSignal, noCp);
    expect(u.notes).not.toHaveBeenCalled();
    expect(u.events).toEqual([]);
  });

  test("no client or no key -> failed for this key point; without a sink a notice instead", async () => {
    const u = unit();
    u.v.folders.add("F");
    u.client.v = null;
    await u.flow.run(kjob("F", "Fusion"), noSignal, noCp);
    expect(u.kinds()).toEqual([{ kind: "failed", error: "no Claude API key — add it in the plugin settings" }]);
    const k = unit({ apiKey: " " });
    k.deps.progress = undefined;
    await k.flow.run(kjob("F", "Fusion"), noSignal, noCp);
    expect(k.errors).toEqual(['Could not research "Fusion": no Claude API key — add it in the plugin settings']);
    expect(k.notes).not.toHaveBeenCalled();
  });

  test("non-retryable error -> failed with the reason, no throw, no notify when a sink exists", async () => {
    const u = unit();
    u.v.folders.add("F");
    u.notes.mockRejectedValue(new ApiError("bad request", 400));
    await expect(u.flow.run(kjob("F", "Fusion"), noSignal, noCp)).resolves.toBeUndefined();
    expect(u.kinds().at(-1)).toEqual({ kind: "failed", error: "bad request" });
    expect([...u.errors, ...u.infos]).toEqual([]);
    expect([...u.v.files.keys()]).toEqual([]);
  });

  test("retryable error -> retry step and rethrow; the retry keeps the run id; cancelled -> failed Cancelled", async () => {
    const u = unit();
    u.v.folders.add("F");
    u.notes.mockRejectedValueOnce(new ApiError("overloaded", 529));
    await expect(u.flow.run(kjob("F", "Fusion"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(u.kinds().at(-1)).toEqual({ kind: "step", text: 'Retrying "Fusion" after a temporary error…' });
    await u.flow.run(kjob("F", "Fusion"), noSignal, noCp);
    expect(u.kinds().at(-1)).toEqual({ kind: "done", folders: 1, notes: 3 });
    expect(new Set(u.events.map((e) => e[2].runId)).size).toBe(1);

    const c = unit();
    c.v.folders.add("F");
    await c.flow.run(kjob("F", "Fusion"), { cancelled: true }, noCp);
    expect(c.kinds()).toEqual([{ kind: "failed", error: CANCELLED_MESSAGE }]);
    expect(c.notes).not.toHaveBeenCalled();
    const d = unit();
    d.v.folders.add("F");
    const sig = { cancelled: false };
    d.notes.mockImplementation(async () => { sig.cancelled = true; return [note("x")]; });
    await d.flow.run(kjob("F", "Fusion"), sig, noCp);
    expect(d.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
    expect([...d.v.files.keys()]).toEqual([]);
  });

  test("endRun forgets a pending retry: the next run gets a new run id", async () => {
    const u = unit();
    u.v.folders.add("F");
    u.notes.mockRejectedValueOnce(new ApiError("overloaded", 529));
    await u.flow.run(kjob("F", "Fusion"), noSignal, noCp).catch(() => {});
    const first = u.events[0][2].runId;
    u.flow.endRun("F/Fusion.md");
    await u.flow.run(kjob("F", "Fusion"), noSignal, noCp);
    expect(u.events.at(-1)![2].runId).not.toBe(first);
  });

  test("one failing keypoint job (non-retryable) emits failed for it only; the other four still complete (real queue, maxConcurrent 2)", async () => {
    const u = unit();
    let active = 0, max = 0;
    u.notes.mockImplementation(async (_t: string, _p: string[], s: SubfolderSuggestion, count: number) => {
      active++; max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (s.name === "Gravity") throw new ApiError("bad request", 400);
      return Array.from({ length: count }, (_, i) => note(`${s.name} ${i + 1}`));
    });
    const failedByQueue: Job[] = [];
    const q = new JobQueue(u.flow.run, {
      maxConcurrent: () => 2, maxRetries: () => 3, persist: async () => {}, sleep: async () => {}, rand: () => 0.5,
      onChange: () => {}, onFailed: (j) => { failedByQueue.push(j); },
    });
    for (const n of NAMES) { u.v.folders.add(`P/${n}`); q.add(kjob(`P/${n}`, n)); }
    await q.idle();
    expect(max).toBe(2);
    const ends = u.events.filter(([, e]) => e.kind === "done" || e.kind === "failed").map(([p, e]) => [p, e.kind]);
    expect(ends).toHaveLength(5);
    expect(ends.filter(([, k]) => k === "failed")).toEqual([["P/Gravity/Gravity.md", "failed"]]);
    for (const n of NAMES.filter((x) => x !== "Gravity")) expect(u.v.files.has(`P/${n}/${n} 1.md`)).toBe(true);
    expect(failedByQueue).toEqual([]);
  });

  test("web search follows the setting: the real client sends the web search tool only when it is on", async () => {
    for (const useWebSearch of [true, false]) {
      const bodies: any[] = [];
      const http: HttpFn = async (req) => {
        bodies.push(JSON.parse(req.body));
        return { status: 200, headers: {}, json: { content: [{ type: "text", text: JSON.stringify({ notes: [note("A"), note("B"), note("C")] }) }] } };
      };
      const u = unit({ useWebSearch });
      const s = { ...settingsBase, useWebSearch };
      u.client.v = new ClaudeClient(http, () => ({ apiKey: s.apiKey, model: s.model, useWebSearch: s.useWebSearch }));
      u.v.folders.add("F");
      await u.flow.run(kjob("F", "Fusion"), noSignal, noCp);
      expect(bodies).toHaveLength(1);
      if (useWebSearch) expect(bodies[0].tools?.[0]?.name).toBe("web_search");
      else expect(bodies[0].tools).toBeUndefined();
      expect(JSON.stringify(bodies[0].messages)).toContain("A paper about stars.");
      expect(u.kinds().at(-1)).toEqual({ kind: "done", folders: 1, notes: 3 });
    }
  });
});

describe("hub: keypoint events are keyed by the entry note path; the spinner shows on the folder", () => {
  function hubOnly() {
    const notices: { text: string; error: boolean }[] = [];
    const spinners: string[][] = [];
    const hub = new ProgressHub(
      { notice: (t, o) => { notices.push({ text: t, error: !!o?.error }); }, setStatus: () => {}, setSpinners: (p) => { spinners.push([...p]); }, reviewModal: async () => null },
      { startApproved: () => true, pathExists: () => true, persistPending: () => {} },
    );
    return { hub, notices, spin: () => spinners.at(-1) ?? [] };
  }

  test("onQueueFailed for a keypoint job ends that job's run: one notice naming the key point, spinner cleared", () => {
    const h = hubOnly();
    const j = kjob("P/Gravity", "Gravity");
    h.hub.sink("P/Gravity/Gravity.md", { kind: "step", text: "Researching…" }, { kind: "keypoint", resumed: false, runId: 7 });
    expect(h.spin()).toEqual(["P/Gravity"]);
    h.hub.onQueueFailed(j, new ApiError("overloaded", 529));
    expect(h.notices).toEqual([{ text: 'Could not research "Gravity": overloaded', error: true }]);
    expect(h.spin()).toEqual([]);
  });

  test("two key points in one folder: the folder spins once until both runs end; one failure gives one notice naming that point", () => {
    const h = hubOnly();
    const src = (runId: number) => ({ kind: "keypoint" as const, resumed: false, runId });
    h.hub.sink("S/Anatomy/Core.md", { kind: "step", text: "a" }, src(1));
    h.hub.sink("S/Anatomy/Mantle.md", { kind: "step", text: "b" }, src(2));
    expect(h.spin()).toEqual(["S/Anatomy"]);
    h.hub.sink("S/Anatomy/Core.md", { kind: "failed", error: "bad request" }, src(1));
    expect(h.notices).toEqual([{ text: 'Could not research "Core": bad request', error: true }]);
    expect(h.spin()).toEqual(["S/Anatomy"]);
    h.hub.sink("S/Anatomy/Mantle.md", { kind: "done", folders: 1, notes: 3 }, src(2));
    expect(h.spin()).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  test("restorePending shows 'Resuming' for a restored keypoint job, spinning on its folder", () => {
    const h = hubOnly();
    h.hub.restorePending([], [kjob("P/Gravity", "Gravity"), kjob("P/Gravity", "Other")]);
    expect(h.spin()).toEqual(["P/Gravity"]);
  });
});

// ---- Full two-stage runs: real PdfFlow + KeypointFlow + JobQueue + ProgressHub + VaultWriter on an in-memory vault ----

let pdf1: ArrayBuffer;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText("stars");
  const u = await doc.save();
  pdf1 = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
});

function world(opts: { overview?: PdfOverview; fail?: Record<string, Error>; delay?: Record<string, number>; during?: Record<string, () => void> } = {}) {
  const v = new MemVault();
  const writer = new VaultWriter(v);
  const settings = { ...settingsBase };
  const files = new Map<string, ArrayBuffer>();
  const calls = { notes: [] as string[], overview: 0 };
  const client = {
    async outline(): Promise<never> { throw new Error("unused"); },
    async notes(_t: string, _p: string[], s: SubfolderSuggestion, count: number) {
      calls.notes.push(s.name);
      await new Promise((r) => setTimeout(r, opts.delay?.[s.name] ?? 2));
      opts.during?.[s.name]?.();
      const err = opts.fail?.[s.name];
      if (err) throw err;
      return Array.from({ length: count }, (_, i) => note(`${s.name} note ${i + 1}`));
    },
    async overviewPdf() { calls.overview++; return opts.overview ?? FIVE; },
    async mergeOverviews(): Promise<never> { throw new Error("single chunk: no merge"); },
  };
  const notices: { text: string; error: boolean }[] = [];
  const spinners: string[][] = [];
  const hub = new ProgressHub(
    { notice: (t, o) => { notices.push({ text: t, error: !!o?.error }); }, setStatus: () => {}, setSpinners: (p) => { spinners.push([...p]); }, reviewModal: async () => null },
    { startApproved: () => true, pathExists: () => true, persistPending: () => {} },
  );
  const flowNotices: string[] = [];
  const notify = { info: (m: string) => flowNotices.push(m), error: (m: string) => flowNotices.push(m) };
  // eslint-disable-next-line prefer-const
  let queue: JobQueue;
  const pdfFlow = new PdfFlow({
    client: () => client as any, writer, notify, progress: hub.sink,
    confirm: { confirm: async () => true },
    readBinary: async (p) => { const b = files.get(p); if (!b) throw new Error("ENOENT"); return b; },
    settings: () => settings, today: () => DATE, now: () => 1,
    enqueue: (j) => queue.add(j),
    processed: () => ({}),
    markProcessed: async () => {},
    rename: async (from, to) => {
      const b = files.get(from); if (b) { files.delete(from); files.set(to, b); }
      const c = v.files.get(from); if (c !== undefined) { v.files.delete(from); v.files.set(to, c); }
    },
  });
  const keypointFlow = new KeypointFlow({ client: () => client as any, writer, notify, progress: hub.sink, settings: () => settings, today: () => DATE });
  // Mirrors main.ts: dispatch by kind; keypoint failures are keyed by the folder.
  queue = new JobQueue(async (job, signal, cp) => {
    if (job.kind === "keypoint") return keypointFlow.run(job, signal, cp);
    if (job.kind === "pdf") return pdfFlow.run(job, signal, cp);
  }, {
    maxConcurrent: () => settings.maxConcurrent, maxRetries: () => settings.maxRetries,
    persist: async () => {}, sleep: async () => {}, rand: () => 0.5,
    onChange: (r, q) => hub.onQueueChange(r, q),
    onFailed: (job, err) => {
      pdfFlow.dropCache(job.path);
      if (job.kind === "pdf") pdfFlow.endRun(job.path); else keypointFlow.endRun(job.path);
      hub.onQueueFailed(job, err);
    },
  });
  pdfFlow.markReady();
  const drop = (path: string) => { files.set(path, pdf1); v.files.set(path, "%PDF"); };
  return { v, writer, hub, queue, pdfFlow, keypointFlow, calls, notices, spinners, flowNotices, drop, settings };
}

const linkTargets = (md: string) => {
  const section = md.slice(md.indexOf("## Key points"), md.indexOf("## In plain words"));
  return [...section.matchAll(/\[\[([^|\]]+)\|[^\]]+\]\]/g)].map((m) => m[1]);
};

describe("two-stage PDF research end to end", () => {
  test("two key points routed into one existing subfolder: one fails while the other runs -> one notice naming it, the folder spins until both end", async () => {
    const snap: { spin: string[]; notices: string[] }[] = [];
    // eslint-disable-next-line prefer-const
    let w: ReturnType<typeof world>;
    w = world({
      overview: { ...FIVE, keyPoints: [kp("Mantle", 2, "Anatomy"), kp("Core", 3, "Anatomy")] },
      fail: { Core: new ApiError("bad request", 400) },
      delay: { Mantle: 40, Core: 1 },
      during: { Mantle: () => { snap.push({ spin: [...(w.spinners.at(-1) ?? [])], notices: w.notices.map((n) => n.text) }); } },
    });
    w.v.folders.add("Stars");
    w.v.folders.add("Stars/Anatomy");
    w.v.files.set("Stars/Stars - Overview.md", "---\nresearch-root: true\n---\n");
    w.drop("Stars/paper+.pdf");
    await w.pdfFlow.onFileEvent("Stars/paper+.pdf");
    await w.queue.idle();
    // While Mantle was still running, Core had already failed: its notice was shown and the folder still spun.
    expect(snap).toHaveLength(1);
    expect(snap[0].notices).toContain('Could not research "Core": bad request');
    expect(snap[0].spin).toContain("Stars/Anatomy");
    expect(w.notices.filter((n) => n.error)).toEqual([{ text: 'Could not research "Core": bad request', error: true }]);
    expect(w.v.files.has("Stars/Anatomy/Mantle note 1.md")).toBe(true);
    expect(w.spinners.at(-1)).toEqual([]);
  });

  test("trigger -> 'Overview ready' notice once, five key point spinners while their jobs run, cleared at the end, one error notice for a failed key point", async () => {
    const w = world({ fail: { Gravity: new ApiError("bad request", 400) } });
    w.v.folders.add("Inbox");
    w.drop("Inbox/paper+.pdf");
    await w.pdfFlow.onFileEvent("Inbox/paper+.pdf");
    await w.queue.idle();
    expect(w.notices).toEqual([
      { text: "Overview ready for paper.pdf — researching 5 key points", error: false },
      { text: 'Could not research "Gravity": bad request', error: true },
    ]);
    const folders = NAMES.map((n) => `Inbox/paper/${n}`);
    const seen = new Set(w.spinners.flat());
    expect(seen.has("Inbox/paper.pdf")).toBe(true);
    for (const f of folders) expect(seen.has(f)).toBe(true);
    // The queue honours maxConcurrent: never more than two key point folders spin at once.
    expect(Math.max(...w.spinners.map((s) => s.filter((p) => folders.includes(p)).length))).toBeLessThanOrEqual(2);
    expect(w.spinners.at(-1)).toEqual([]);
    expect(w.calls.notes.sort()).toEqual([...NAMES].sort());
    expect(w.flowNotices).toEqual([]);
  });

  test("a keypoint job that keeps failing with a retryable error: the queue's give-up is reported once on the folder", async () => {
    const w = world({ fail: { "Neutron stars": new ApiError("overloaded", 529) } });
    w.drop("paper+.pdf");
    await w.pdfFlow.onFileEvent("paper+.pdf");
    await w.queue.idle();
    expect(w.notices.filter((n) => n.error)).toEqual([{ text: 'Could not research "Neutron stars": overloaded', error: true }]);
    expect(w.spinners.at(-1)).toEqual([]);
  });

  test("outside a root: the PDF stays in place, '<dir>/<stem>/' holds the marked overview, every link resolves and each folder gets its notes", async () => {
    const w = world();
    w.v.folders.add("Inbox");
    w.drop("Inbox/paper+.pdf");
    await w.pdfFlow.onFileEvent("Inbox/paper+.pdf");
    await w.queue.idle();
    expect(w.v.files.has("Inbox/paper.pdf")).toBe(true);
    const md = w.v.files.get("Inbox/paper/paper - Overview.md")!;
    expect(md).toContain("research-root: true");
    const targets = linkTargets(md);
    expect(targets).toHaveLength(5);
    for (const t of targets) expect(w.v.files.has(`${t}.md`)).toBe(true);
    for (const n of NAMES) for (const i of [1, 2, 3]) expect(w.v.files.has(`Inbox/paper/${n}/${n} note ${i}.md`)).toBe(true);
  });

  test("inside a root: the overview lands in Sources, matching points go to the existing subfolder, links resolve, notes carry the root's chain", async () => {
    const parents: string[][] = [];
    const w = world({ overview: { ...FIVE, keyPoints: [kp("Core", 2, "Anatomy"), kp("Jets", 7)] } });
    w.v.folders.add("Stars");
    w.v.folders.add("Stars/Anatomy");
    w.v.files.set("Stars/Stars - Overview.md", "---\nresearch-root: true\n---\n");
    const realNotes = (w.keypointFlow as any).deps.client().notes;
    (w.keypointFlow as any).deps.client = () => ({ notes: async (t: string, p: string[], s: SubfolderSuggestion, n: number) => { parents.push([t, ...p]); return realNotes(t, p, s, n); } });
    w.drop("Stars/Anatomy/paper+.pdf");
    await w.pdfFlow.onFileEvent("Stars/Anatomy/paper+.pdf");
    await w.queue.idle();
    const md = w.v.files.get("Stars/Sources/paper - Overview.md")!;
    expect(md).not.toContain("research-root");
    expect(linkTargets(md)).toEqual(["Stars/Anatomy/Core", "Stars/From PDFs/Jets/Jets"]);
    for (const t of linkTargets(md)) expect(w.v.files.has(`${t}.md`)).toBe(true);
    expect(w.v.files.has("Stars/Anatomy/Core note 1.md")).toBe(true);
    expect(w.v.files.has("Stars/From PDFs/Jets/Jets note 3.md")).toBe(true);
    expect(parents).toEqual([["paper", "Stars"], ["paper", "Stars"]]);
    expect(w.notices).toEqual([{ text: "Overview ready for paper.pdf — researching 2 key points", error: false }]);
  });
});
