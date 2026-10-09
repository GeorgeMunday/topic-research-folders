import { describe, expect, test, vi } from "vitest";
import { ResearchFlow, type ResearchDeps } from "../src/flows/researchFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { JobQueue, ApiError } from "../src/jobs/queue";
import type { Job, Outline, SubfolderSuggestion, NoteContent } from "../src/types";
import type { Settings } from "../src/settings";
import type { Progress } from "../src/types";
import { CANCELLED_MESSAGE, OUTLINE_STAGE_MS, type ProgressSource } from "../src/progress";

class MemVault implements VaultLike {
  files = new Map<string, string>();
  folders = new Set<string>();
  exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async read(p: string) {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("no file " + p);
    return c;
  }
  async createFolder(p: string) {
    if (this.exists(p)) throw new Error("exists " + p);
    this.folders.add(p);
  }
  async createFile(p: string, c: string) {
    if (this.exists(p)) throw new Error("exists " + p);
    this.files.set(p, c);
  }
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
const ROOT_MARK = "---\nresearch-root: true\n---\n";

const baseSettings: Settings = {
  apiKey: "key", model: "m", useWebSearch: false, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 6, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 1, maxRetries: 3,
  processPdfs: true, pdfPagesPerChunk: 20, confirmAbovePages: 100,
};

function setup(over: { settings?: Partial<Settings>; approve?: SubfolderSuggestion[] | null; pdfs?: string[]; keyless?: boolean } = {}) {
  const v = new MemVault();
  const writer = new VaultWriter(v);
  const calls = { outline: [] as any[], notes: [] as any[], approve: 0, approvePaths: [] as string[] };
  const infos: string[] = [], errors: string[] = [], renames: [string, string][] = [], enqueued: Job[] = [], queuedPdfs: string[][] = [];
  const failNotes = new Map<string, Error>();
  const settings = { ...baseSettings, ...over.settings };
  const client = {
    async outline(topic: string, parents: string[], max: number): Promise<Outline> {
      calls.outline.push([topic, parents, max]);
      return { topic, summary: "sum", subfolders: [A, B, C] };
    },
    async notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number) {
      calls.notes.push([topic, parents, s.name, count]);
      const e = failNotes.get(s.name);
      if (e) throw e;
      return [note(`${s.name} note`)];
    },
    async extractPdf(): Promise<never> { throw new Error("unused"); },
  };
  const deps: ResearchDeps = {
    client: () => (over.keyless ? null : client),
    writer,
    approver: { async approve(o, jobPath) { calls.approve++; calls.approvePaths.push(jobPath); return over.approve === undefined ? o.subfolders.slice(0, 2) : over.approve; } },
    notify: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
    rename: async (from, to) => {
      renames.push([from, to]);
      if (v.folders.delete(from)) v.folders.add(to);
    },
    settings: () => settings,
    today: () => "2026-10-08",
    enqueue: (j) => { enqueued.push(j); return true; },
    listPdfs: () => over.pdfs ?? [],
    queuePdfs: async (paths) => { queuedPdfs.push(paths); },
  };
  const flow = new ResearchFlow(deps);
  const run = (job: Job) => flow.run(job, { cancelled: false }, async () => {});
  return { v, writer, flow, deps, calls, infos, errors, renames, enqueued, queuedPdfs, failNotes, run, settings };
}

const rjob = (path: string, extra: Partial<Extract<Job, { kind: "research" }>> = {}): Job =>
  ({ id: `research:${path}`, kind: "research", path, done: [], ...extra });

describe("events", () => {
  test("ignores events before ready", async () => {
    const s = setup();
    await s.flow.onFolderEvent("Black holes+");
    expect(s.enqueued).toEqual([]);
    expect(s.renames).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test("ignores non-trigger names", async () => {
    const s = setup();
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes");
    await s.flow.onFolderEvent("+");
    expect(s.enqueued).toEqual([]);
    expect(s.renames).toEqual([]);
  });

  test("triggers on rename into suffix", async () => {
    const s = setup();
    s.v.folders.add("Black holes+");
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes+"); // rename events arrive the same way as create
    expect(s.enqueued).toHaveLength(1);
  });

  test("missing API key -> error notice, nothing renamed or queued", async () => {
    const s = setup({ settings: { apiKey: "" } });
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes+");
    expect(s.errors).toHaveLength(1);
    expect(s.renames).toEqual([]);
    expect(s.enqueued).toEqual([]);
  });

  test("strips suffix then queues job for the stripped path", async () => {
    const s = setup();
    s.v.folders.add("Black holes+");
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes+");
    expect(s.renames).toEqual([["Black holes+", "Black holes"]]);
    expect(s.enqueued).toEqual([{ id: "research:Black holes", kind: "research", path: "Black holes", done: [] }]);
  });

  test("stripSuffix false keeps the path", async () => {
    const s = setup({ settings: { stripSuffix: false } });
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes+");
    expect(s.renames).toEqual([]);
    expect(s.enqueued[0].path).toBe("Black holes+");
  });

  test("rename collision gets a unique name", async () => {
    const s = setup();
    s.v.folders.add("Black holes+");
    s.v.folders.add("black holes");
    s.v.folders.add("Black holes (2)");
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes+");
    expect(s.renames).toEqual([["Black holes+", "Black holes (3)"]]);
    expect(s.enqueued[0].path).toBe("Black holes (3)");
  });

  test("beyond maxDepth -> notice, no job, no rename", async () => {
    const s = setup({ settings: { maxDepth: 2 } });
    s.v.folders.add("Black holes");
    s.v.files.set("Black holes/Black holes - Overview.md", ROOT_MARK);
    s.v.folders.add("Black holes/Anatomy");
    s.v.files.set("Black holes/Anatomy/Anatomy - Overview.md", ROOT_MARK);
    s.v.folders.add("Black holes/Anatomy/Deep+");
    s.flow.markReady();
    await s.flow.onFolderEvent("Black holes/Anatomy/Deep+");
    expect(s.enqueued).toEqual([]);
    expect(s.renames).toEqual([]);
    expect(s.errors).toHaveLength(1);
  });

  test("researchFolder needs no suffix and does not rename", async () => {
    const s = setup();
    await s.flow.researchFolder("Stars");
    expect(s.renames).toEqual([]);
    expect(s.enqueued[0]).toMatchObject({ kind: "research", path: "Stars" });
  });
});

describe("run", () => {
  test("writes only approved subfolders, then overview", async () => {
    const s = setup({ approve: [A, C] });
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    expect(s.calls.outline).toEqual([["Black holes", [], 6]]);
    expect(s.calls.notes.map((c) => c[2])).toEqual(["A", "C"]);
    expect(s.calls.notes[0]).toEqual(["Black holes", [], "A", 3]);
    expect(s.v.files.has("Black holes/A/A note.md")).toBe(true);
    expect(s.v.files.has("Black holes/C/C note.md")).toBe(true);
    expect(s.v.folders.has("Black holes/B")).toBe(false);
    const ov = s.v.files.get("Black holes/Black holes - Overview.md")!;
    expect(ov).toContain("research-root: true");
    expect(ov).toContain("A note");
    expect(s.infos.some((m) => m.includes("Black holes"))).toBe(true);
  });

  test("cancelled approval writes nothing", async () => {
    const s = setup({ approve: null });
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    expect(s.calls.notes).toEqual([]);
    expect([...s.v.files.keys()]).toEqual([]);
    expect(s.v.folders.size).toBe(1);
  });

  test("nested: trigger inside research root passes parents to prompts", async () => {
    const s = setup();
    s.v.folders.add("Black holes");
    s.v.files.set("Black holes/Black holes - Overview.md", ROOT_MARK);
    s.v.folders.add("Black holes/Anatomy");
    await s.run(rjob("Black holes/Anatomy"));
    expect(s.calls.outline).toEqual([["Anatomy", ["Black holes"], 6]]);
    expect(s.calls.notes[0].slice(0, 2)).toEqual(["Anatomy", ["Black holes"]]);
  });

  test("checkpoints approved + done; resumed job skips approval and done subfolders", async () => {
    const s = setup({ approve: [A, B, C] });
    s.v.folders.add("T");
    const cps: Job[] = [];
    await s.flow.run(rjob("T"), { cancelled: false }, async (j) => { cps.push(JSON.parse(JSON.stringify(j))); });
    expect(cps[0]).toMatchObject({ approved: [A, B, C], done: [] });
    expect(cps.map((j) => (j as any).done)).toEqual([[], ["A"], ["A", "B"], ["A", "B", "C"]]);

    const r = setup();
    r.v.folders.add("T");
    await r.run(rjob("T", { approved: [A, B, C], done: ["A"] }));
    expect(r.calls.approve).toBe(0);
    expect(r.calls.outline).toEqual([]);
    expect(r.calls.notes.map((c) => c[2])).toEqual(["B", "C"]);
    expect(r.v.files.has("T/T - Overview.md")).toBe(true);
  });

  test("one subfolder failing does not abort others", async () => {
    const s = setup({ approve: [A, B, C] });
    s.v.folders.add("T");
    s.failNotes.set("B", new Error("bad"));
    await s.run(rjob("T"));
    expect(s.errors.some((m) => m.includes("B"))).toBe(true);
    expect(s.v.files.has("T/A/A note.md")).toBe(true);
    expect(s.v.files.has("T/C/C note.md")).toBe(true);
    expect(s.v.folders.has("T/B")).toBe(false);
  });

  test("stops at next subfolder when cancelled", async () => {
    const s = setup({ approve: [A, B, C] });
    s.v.folders.add("T");
    const signal = { cancelled: false };
    const orig = s.deps.writer.writeSubfolder.bind(s.deps.writer);
    s.deps.writer.writeSubfolder = async (...a: Parameters<typeof orig>) => {
      const r = await orig(...a);
      signal.cancelled = true;
      return r;
    };
    await s.flow.run(rjob("T"), signal, async () => {});
    expect(s.calls.notes.map((c) => c[2])).toEqual(["A"]);
    expect(s.v.files.has("T/T - Overview.md")).toBe(false);
  });

  test("after finishing, hands the PDFs under the root to queuePdfs (not enqueued directly)", async () => {
    const s = setup({ pdfs: ["Black holes/a.pdf", "Black holes/x/b.pdf"] });
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    expect(s.queuedPdfs).toEqual([["Black holes/a.pdf", "Black holes/x/b.pdf"]]);
    expect(s.enqueued.filter((j) => j.kind === "pdf")).toEqual([]);
  });

  test("30 existing PDFs -> queuePdfs once with all 30 paths, no direct pdf enqueue", async () => {
    const pdfs = Array.from({ length: 30 }, (_, i) => `T/d${i}.pdf`);
    const s = setup({ pdfs });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.queuedPdfs).toHaveLength(1);
    expect(s.queuedPdfs[0]).toEqual(pdfs);
    expect(s.enqueued).toEqual([]);
  });

  test("no PDFs queued when processPdfs is off", async () => {
    const s = setup({ pdfs: ["T/a.pdf"], settings: { processPdfs: false } });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.queuedPdfs).toEqual([]);
    expect(s.enqueued).toEqual([]);
  });

  test("missing key at run time -> error, nothing written", async () => {
    const s = setup({ keyless: true });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.errors).toHaveLength(1);
    expect(s.v.files.size).toBe(0);
  });

  test("overview links use the actual folder name written", async () => {
    const s = setup({ approve: [A] });
    s.v.folders.add("T");
    s.v.folders.add("T/A");
    await s.run(rjob("T"));
    expect(s.v.files.has("T/A (2)/A note.md")).toBe(true);
    const ov = s.v.files.get("T/T - Overview.md")!;
    expect(ov).toContain("**A (2)**");
  });

  test("overview links are full-path wikilinks, distinct for repeated titles", async () => {
    const s = setup({ approve: [A, B] });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    const ov = s.v.files.get("T/T - Overview.md")!;
    expect(ov).toContain("[[T/A/A note|A note]]");
    expect(ov).toContain("[[T/B/B note|B note]]");
  });

  test("fresh job on a folder that already has its own marked overview is skipped with a notice", async () => {
    const s = setup();
    s.v.folders.add("T");
    s.v.files.set("T/T - Overview.md", ROOT_MARK);
    await s.run(rjob("T"));
    expect(s.infos).toEqual(["\"T\" is already researched."]);
    expect(s.calls.outline).toEqual([]);
    expect(s.calls.approve).toBe(0);
    expect(s.calls.notes).toEqual([]);
    expect(s.v.files.size).toBe(1);
  });

  test("resumed job continues even though its overview already exists", async () => {
    const s = setup();
    s.v.folders.add("T");
    s.v.files.set("T/T - Overview.md", ROOT_MARK);
    await s.run(rjob("T", { approved: [A, B], done: ["A"] }));
    expect(s.infos.some((m) => m.includes("already researched"))).toBe(false);
    expect(s.calls.notes.map((c) => c[2])).toEqual(["B"]);
    expect(s.v.files.has("T/B/B note.md")).toBe(true);
  });

  test("an unmarked overview or a marked ancestor does not count as already researched", async () => {
    const s = setup();
    s.v.folders.add("T");
    s.v.files.set("T/T - Overview.md", "---\ntopic: x\n---\n");
    await s.run(rjob("T"));
    expect(s.calls.approve).toBe(1);
  });

  test("run re-checks depth at start", async () => {
    const s = setup({ settings: { maxDepth: 1 } });
    s.v.folders.add("Black holes");
    s.v.files.set("Black holes/Black holes - Overview.md", ROOT_MARK);
    s.v.folders.add("Black holes/Anatomy");
    await s.run(rjob("Black holes/Anatomy"));
    expect(s.errors).toHaveLength(1);
    expect(s.calls.outline).toEqual([]);
    expect(s.calls.approve).toBe(0);
  });

  test("a subfolder the writer created does not re-trigger; a user one does", async () => {
    const s = setup({ approve: [sug("C++")] });
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    s.flow.markReady();
    s.enqueued.length = 0;
    await s.flow.onFolderEvent("Black holes/C++");
    expect(s.enqueued).toEqual([]);
    expect(s.renames).toEqual([]);
    s.v.folders.add("Black holes/Another+");
    await s.flow.onFolderEvent("Black holes/Another+");
    expect(s.enqueued).toHaveLength(1);
  });

  test("real queue: retryable failure resumes from checkpoint without re-approving or rewriting", async () => {
    const s = setup({ approve: [A, B] });
    s.v.folders.add("T");
    let bCalls = 0;
    const origGet = s.failNotes.get.bind(s.failNotes);
    s.failNotes.get = (k: string) => (k === "B" ? (bCalls++ === 0 ? new ApiError("overloaded", 503) : undefined) : origGet(k));
    let failed = 0;
    const q = new JobQueue(s.flow.run, {
      maxConcurrent: () => 1, maxRetries: () => 3,
      persist: async () => {}, sleep: async () => {}, rand: () => 0.5,
      onChange: () => {}, onFailed: () => { failed++; },
    });
    q.add(rjob("T"));
    await q.idle();
    expect(failed).toBe(0);
    expect(s.calls.approve).toBe(1);
    expect(s.calls.notes.filter((c) => c[2] === "A")).toHaveLength(1);
    expect(s.calls.notes.filter((c) => c[2] === "B")).toHaveLength(2);
    expect(s.v.files.has("T/A/A note.md")).toBe(true);
    expect(s.v.files.has("T/B/B note.md")).toBe(true);
    expect(s.v.folders.has("T/A (2)")).toBe(false);
  });
});

describe("progress events", () => {
  type Ev = [string, Progress, ProgressSource];
  function withSink(over: Parameters<typeof setup>[0] = {}) {
    const s = setup(over);
    const events: Ev[] = [];
    s.deps.progress = (p, e, src) => { events.push([p, e, src]); };
    const kinds = () => events.map((x) => x[1]);
    const timers: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = [];
    return { ...s, events, kinds, timers };
  }
  const withLater = (s: ReturnType<typeof withSink>) => {
    s.deps.later = (fn, ms) => { const cancel = vi.fn(); s.timers.push({ fn, ms, cancel }); return cancel; };
  };

  test("successful run emits step, step, outline, writing/itemDone per subfolder, then done with folder and note counts", async () => {
    const s = withSink({ settings: { useWebSearch: true }, approve: [A, C] });
    withLater(s);
    s.v.folders.add("T");
    await s.run(rjob("T"));
    const k = s.kinds();
    expect(k[0]).toEqual({ kind: "step", text: "Searching the web…" });
    expect(k.find((e) => e.kind === "outline")).toMatchObject({ kind: "outline", outline: { topic: "T" } });
    const rest = k.filter((e) => e.kind === "writing" || e.kind === "itemDone" || e.kind === "done");
    expect(rest).toEqual([
      { kind: "writing", index: 1, total: 2, name: "A" }, { kind: "itemDone", name: "A", ok: true },
      { kind: "writing", index: 2, total: 2, name: "C" }, { kind: "itemDone", name: "C", ok: true },
      { kind: "done", folders: 2, notes: 2 },
    ]);
    expect(s.events.every((e) => e[0] === "T" && e[2].kind === "research" && e[2].resumed === false)).toBe(true);
    expect(s.infos).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test("the second step only fires if the outline is still pending, and its timer is cancelled when the outline arrives", async () => {
    const s = withSink({ settings: { useWebSearch: true } });
    withLater(s);
    s.v.folders.add("T");
    const orig = s.deps.client()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    s.deps.client = () => ({ ...orig, outline: async (...a: Parameters<typeof orig.outline>) => { await gate; return orig.outline(...a); } });
    const p = s.run(rjob("T"));
    await new Promise((r) => setTimeout(r, 5));
    expect(s.timers).toHaveLength(1);
    expect(s.timers[0].ms).toBe(OUTLINE_STAGE_MS);
    expect(s.timers[0].cancel).not.toHaveBeenCalled();
    s.timers[0].fn();
    expect(s.kinds().slice(0, 2)).toEqual([{ kind: "step", text: "Searching the web…" }, { kind: "step", text: "Suggesting folders…" }]);
    release();
    await p;
    expect(s.timers[0].cancel).toHaveBeenCalledTimes(1);

    // outline arrives immediately: the timer is cancelled and never fired, so no second step
    const t = withSink({ settings: { useWebSearch: true } });
    withLater(t);
    t.v.folders.add("T");
    await t.run(rjob("T"));
    expect(t.timers[0].cancel).toHaveBeenCalledTimes(1);
    expect(t.kinds().filter((e) => e.kind === "step")).toEqual([{ kind: "step", text: "Searching the web…" }]);
  });

  test("web search off: first step is 'Suggesting folders…' and later() is not used", async () => {
    const s = withSink({ settings: { useWebSearch: false } });
    withLater(s);
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.kinds()[0]).toEqual({ kind: "step", text: "Suggesting folders…" });
    expect(s.timers).toEqual([]);
  });

  test("failed outline (non-retryable) emits failed with the message and does not throw or notify", async () => {
    const s = withSink();
    s.v.folders.add("T");
    const orig = s.deps.client()!;
    s.deps.client = () => ({ ...orig, outline: async () => { throw new ApiError("bad request", 400); } });
    await expect(s.run(rjob("T"))).resolves.toBeUndefined();
    expect(s.kinds().at(-1)).toMatchObject({ kind: "failed", error: expect.stringContaining("bad request") });
    expect(s.kinds().filter((e) => e.kind === "failed" || e.kind === "done")).toHaveLength(1);
    expect(s.errors).toEqual([]);
    expect(s.infos).toEqual([]);
  });

  test("retryable outline error emits the retry step and rethrows", async () => {
    const s = withSink();
    s.v.folders.add("T");
    const orig = s.deps.client()!;
    s.deps.client = () => ({ ...orig, outline: async () => { throw new ApiError("overloaded", 503); } });
    await expect(s.run(rjob("T"))).rejects.toBeInstanceOf(ApiError);
    expect(s.kinds().at(-1)).toEqual({ kind: "step", text: "Retrying after a temporary error…" });
    expect(s.kinds().some((e) => e.kind === "failed" || e.kind === "done")).toBe(false);
  });

  test("one failing subfolder emits itemDone ok:false with the reason, the rest continue, done counts only successes", async () => {
    const s = withSink({ approve: [A, B, C] });
    s.v.folders.add("T");
    s.failNotes.set("B", new Error("bad"));
    await s.run(rjob("T"));
    const k = s.kinds();
    expect(k).toContainEqual({ kind: "itemDone", name: "B", ok: false, error: "bad" });
    expect(k).toContainEqual({ kind: "itemDone", name: "C", ok: true });
    expect(k.at(-1)).toEqual({ kind: "done", folders: 2, notes: 2 });
  });

  test("approval cancelled emits failed CANCELLED_MESSAGE", async () => {
    const s = withSink({ approve: null });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
    expect(s.calls.notes).toEqual([]);
  });

  test("cancel after the outline returns (user pressed Cancel) writes nothing and emits failed CANCELLED_MESSAGE", async () => {
    const s = withSink();
    s.v.folders.add("T");
    const sig = { cancelled: false };
    const orig = s.deps.client()!;
    s.deps.client = () => ({ ...orig, outline: async (...a: Parameters<typeof orig.outline>) => { const r = await orig.outline(...a); sig.cancelled = true; return r; } });
    await s.flow.run(rjob("T"), sig, async () => {});
    expect(s.calls.approve).toBe(0);
    expect(s.calls.notes).toEqual([]);
    expect(s.v.files.size).toBe(0);
    expect(s.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });

    // and cancelled while the approver was open
    const t = withSink();
    t.v.folders.add("T");
    const sig2 = { cancelled: false };
    t.deps.approver = { async approve(o) { sig2.cancelled = true; return o.subfolders; } };
    await t.flow.run(rjob("T"), sig2, async () => {});
    expect(t.calls.notes).toEqual([]);
    expect(t.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
  });

  test("cancel mid-way stops at the next subfolder and emits failed CANCELLED_MESSAGE", async () => {
    const s = withSink({ approve: [A, B, C] });
    s.v.folders.add("T");
    const signal = { cancelled: false };
    const orig = s.deps.writer.writeSubfolder.bind(s.deps.writer);
    s.deps.writer.writeSubfolder = async (...a: Parameters<typeof orig>) => { const r = await orig(...a); signal.cancelled = true; return r; };
    await s.flow.run(rjob("T"), signal, async () => {});
    expect(s.calls.notes.map((c) => c[2])).toEqual(["A"]);
    expect(s.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
    expect(s.kinds().filter((e) => e.kind === "failed" || e.kind === "done")).toHaveLength(1);
  });

  test("cancel before the overview emits failed CANCELLED_MESSAGE", async () => {
    const s = withSink({ approve: [A] });
    s.v.folders.add("T");
    const signal = { cancelled: false };
    const orig = s.deps.writer.writeSubfolder.bind(s.deps.writer);
    s.deps.writer.writeSubfolder = async (...a: Parameters<typeof orig>) => { const r = await orig(...a); signal.cancelled = true; return r; };
    await s.flow.run(rjob("T"), signal, async () => {});
    expect(s.v.files.has("T/T - Overview.md")).toBe(false);
    expect(s.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
  });

  test("resumed research job emits no step that opens a modal: source.resumed true, first event 'Resuming research…'", async () => {
    const s = withSink();
    s.v.folders.add("T");
    await s.run(rjob("T", { approved: [A, B, C], done: ["A"] }));
    expect(s.events[0][1]).toEqual({ kind: "step", text: "Resuming research…" });
    expect(s.events.every((e) => e[2].resumed === true)).toBe(true);
    expect(s.kinds().some((e) => e.kind === "outline")).toBe(false);
    expect(s.kinds().slice(1)).toEqual([
      { kind: "writing", index: 2, total: 3, name: "B" }, { kind: "itemDone", name: "B", ok: true },
      { kind: "writing", index: 3, total: 3, name: "C" }, { kind: "itemDone", name: "C", ok: true },
      { kind: "done", folders: 3, notes: 2 },
    ]);
  });

  test("pre-start exits emit only a terminal failed with the notice text", async () => {
    const a = withSink({ keyless: true });
    await a.run(rjob("T"));
    expect(a.kinds()).toEqual([{ kind: "failed", error: "Add your Claude API key in the plugin settings before researching a topic." }]);
    expect(a.errors).toEqual([]);

    const b = withSink();
    b.v.folders.add("T");
    b.v.files.set("T/T - Overview.md", ROOT_MARK);
    await b.run(rjob("T"));
    expect(b.kinds()).toEqual([{ kind: "failed", error: "\"T\" is already researched." }]);
    expect(b.infos).toEqual([]);

    const c = withSink({ settings: { maxDepth: 1 } });
    c.v.folders.add("R");
    c.v.files.set("R/R - Overview.md", ROOT_MARK);
    c.v.folders.add("R/X");
    await c.run(rjob("R/X"));
    expect(c.kinds()).toHaveLength(1);
    expect(c.kinds()[0]).toMatchObject({ kind: "failed", error: expect.stringContaining("nesting would be 2 levels deep") });
    expect(c.errors).toEqual([]);
  });

  test("approver receives the job path as its second argument", async () => {
    const s = setup();
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    expect(s.calls.approvePaths).toEqual(["Black holes"]);
  });

  test("without a sink the flow still notifies as before", async () => {
    const s = setup({ approve: [A] });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.infos.some((m) => m.includes("Researched T"))).toBe(true);

    const k = setup({ keyless: true });
    await k.run(rjob("T"));
    expect(k.errors).toHaveLength(1);

    const e = setup();
    e.v.folders.add("T");
    const orig = e.deps.client()!;
    e.deps.client = () => ({ ...orig, outline: async () => { throw new ApiError("bad request", 400); } });
    await expect(e.run(rjob("T"))).rejects.toBeInstanceOf(ApiError);
  });
});

describe("run identity", () => {
  function withSink() {
    const s = setup();
    const events: [string, Progress, ProgressSource][] = [];
    s.deps.progress = (p, e, src) => { events.push([p, e, src]); };
    return { ...s, events, ids: () => [...new Set(events.map((x) => x[2].runId))] };
  }
  test("all events of one successful run share one runId", async () => {
    const s = withSink();
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.events.length).toBeGreaterThan(3);
    expect(s.ids()).toHaveLength(1);
    expect(typeof s.ids()[0]).toBe("number");
  });
  test("two successive runs for the same path carry different runIds", async () => {
    const s = withSink();
    s.v.folders.add("T");
    await s.run(rjob("T"));
    const first = s.ids()[0];
    s.v.files.clear();
    await s.run(rjob("T"));
    expect(s.ids()).toHaveLength(2);
    expect(s.events.at(-1)![2].runId).not.toBe(first);
  });
  test("a retry invocation after a retryable error keeps the runId", async () => {
    const s = withSink();
    s.v.folders.add("T");
    const orig = s.deps.client()!;
    let fail = true;
    s.deps.client = () => ({ ...orig, outline: async (...a: [string, string[], number]) => { if (fail) { fail = false; throw new ApiError("overloaded", 503); } return orig.outline(...a); } });
    await expect(s.run(rjob("T"))).rejects.toBeInstanceOf(ApiError);
    await s.run(rjob("T"));
    expect(s.ids()).toHaveLength(1);
  });
  test("a pre-start reject carries a runId different from the previous run's", async () => {
    const s = withSink();
    s.v.folders.add("T");
    await s.run(rjob("T"));
    const first = s.ids()[0];
    await s.run(rjob("T"));
    const last = s.events.at(-1)!;
    expect(last[1]).toMatchObject({ kind: "failed" });
    expect(typeof last[2].runId).toBe("number");
    expect(last[2].runId).not.toBe(first);
  });
});

describe("run identity after cancel and across flows", () => {
  test("a retryable error after a cancel leaves no retry entry: the next run gets a new runId", async () => {
    const s = setup();
    const events: [string, Progress, ProgressSource][] = [];
    s.deps.progress = (p, e, src) => { events.push([p, e, src]); };
    s.v.folders.add("T");
    const orig = s.deps.client()!;
    s.deps.client = () => ({ ...orig, outline: async () => { throw new ApiError("overloaded", 503); } });
    await expect(s.flow.run(rjob("T"), { cancelled: true }, async () => {})).rejects.toBeInstanceOf(ApiError);
    expect(events.some((x) => x[1].kind === "step" && x[1].text.startsWith("Retrying"))).toBe(false);
    const first = events[0][2].runId;
    s.deps.client = () => orig;
    await s.run(rjob("T"));
    expect(events.at(-1)![2].runId).not.toBe(first);
  });
});
