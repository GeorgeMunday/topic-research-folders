import { describe, expect, test } from "vitest";
import { ResearchFlow, type ResearchDeps } from "../src/flows/researchFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { JobQueue, ApiError } from "../src/jobs/queue";
import type { Job, Outline, SubfolderSuggestion, NoteContent } from "../src/types";
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
  const calls = { outline: [] as any[], notes: [] as any[], approve: 0 };
  const infos: string[] = [], errors: string[] = [], renames: [string, string][] = [], enqueued: Job[] = [];
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
    approver: { async approve(o) { calls.approve++; return over.approve === undefined ? o.subfolders.slice(0, 2) : over.approve; } },
    notify: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
    rename: async (from, to) => {
      renames.push([from, to]);
      if (v.folders.delete(from)) v.folders.add(to);
    },
    settings: () => settings,
    today: () => "2026-10-08",
    enqueue: (j) => { enqueued.push(j); return true; },
    listPdfs: () => over.pdfs ?? [],
  };
  const flow = new ResearchFlow(deps);
  const run = (job: Job) => flow.run(job, { cancelled: false }, async () => {});
  return { v, writer, flow, deps, calls, infos, errors, renames, enqueued, failNotes, run, settings };
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
    expect(s.errors.length + s.infos.length).toBe(1);
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

  test("after finishing, enqueues a pdf job for each PDF under the root", async () => {
    const s = setup({ pdfs: ["Black holes/a.pdf", "Black holes/x/b.pdf"] });
    s.v.folders.add("Black holes");
    await s.run(rjob("Black holes"));
    expect(s.enqueued).toEqual([
      { id: "pdf:Black holes/a.pdf", kind: "pdf", path: "Black holes/a.pdf" },
      { id: "pdf:Black holes/x/b.pdf", kind: "pdf", path: "Black holes/x/b.pdf" },
    ]);
  });

  test("no pdf jobs when processPdfs is off", async () => {
    const s = setup({ pdfs: ["T/a.pdf"], settings: { processPdfs: false } });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.enqueued).toEqual([]);
  });

  test("missing key at run time -> error, nothing written", async () => {
    const s = setup({ keyless: true });
    s.v.folders.add("T");
    await s.run(rjob("T"));
    expect(s.errors).toHaveLength(1);
    expect(s.v.files.size).toBe(0);
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
