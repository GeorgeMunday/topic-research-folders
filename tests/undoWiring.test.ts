import { describe, expect, test } from "vitest";
import { ResearchFlow } from "../src/flows/researchFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { RunLog, planUndo, type UndoView } from "../src/undo";
import { mergeData } from "../src/settings";
import type { Settings } from "../src/settings";
import type { Job } from "../src/types";

class MemVault implements VaultLike {
  files = new Map<string, string>();
  folders = new Set<string>();
  exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async read(p: string) { const c = this.files.get(p); if (c === undefined) throw new Error("no file " + p); return c; }
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
const viewOf = (v: MemVault, mtime: number): UndoView => ({
  mtime: (p) => (v.files.has(p) ? mtime : null),
  children: (p) => (v.folders.has(p) ? v.children(p).map((c) => c.name) : null),
});

const settings: Settings = {
  apiKey: "k", model: "m", modelChosen: false, useWebSearch: false, numberFolders: true, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 6, notesPerSubfolder: 2, maxDepth: 5, maxConcurrent: 1, maxRetries: 0,
  processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200,
};
const note = (title: string) => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const quiz = { questions: ["q"], answers: [{ text: "a", note: "n1" }] };

function setup() {
  const v = new MemVault();
  const clock = { t: 5000 };
  const log = new RunLog([], () => {}, () => clock.t);
  const renames: [string, string][] = [];
  const enqueued: Job[] = [];
  const flow = new ResearchFlow({
    client: () => ({ notes: async () => ({ notes: [note("n1")], quiz }) } as any),
    writer: new VaultWriter(v), notify: { info() {}, error() {} },
    rename: async (a, b) => { renames.push([a, b]); },
    settings: () => settings, today: () => "2026-10-09", enqueue: (j) => { enqueued.push(j); return true; }, log,
  });
  return { v, log, flow, renames, enqueued, clock };
}

describe("a research run records what it created", () => {
  test("subfolders, notes, quiz files and the overview; undoing it leaves the user's folder", async () => {
    const { v, log, flow } = setup();
    v.folders.add("c#"); v.folders.add("c#/intro");
    const job: Job = { id: "r", kind: "research", path: "c#/intro", approved: [{ name: "01 - A", why: "w" }, { name: "02 - B", why: "w" }], done: [], run: "research:c#/intro:1" };
    await flow.run(job, { cancelled: false }, async () => {});
    const run = log.last()!;
    expect(run.key).toBe("research:c#/intro:1");
    expect(run.root).toBe("c#/intro");
    expect(run.folders.sort()).toEqual(["c#/intro/01 - A", "c#/intro/02 - B"]);
    // 2 notes + 2 questions + 2 answers + overview
    expect(run.files).toHaveLength(7);
    expect(run.files.every((f) => f.at === 5000)).toBe(true);

    const plan = planUndo(run, viewOf(v, 5000));
    expect(plan.counts).toEqual({ folders: 2, notes: 7 });
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro");
    expect(plan.trash.map((t) => t.path)).not.toContain("c#");
  });

  test("the trigger-suffix rename is remembered, then undone only when the folder ends up empty", async () => {
    const { v, log, flow, renames } = setup();
    flow.markReady();
    v.folders.add("c#"); v.folders.add("c#/intro+");
    await flow.onFolderEvent("c#/intro+");
    expect(renames).toEqual([["c#/intro+", "c#/intro"]]);
    v.folders.delete("c#/intro+"); v.folders.add("c#/intro");   // the rename happened in the vault
    await flow.run({ id: "r", kind: "research", path: "c#/intro", approved: [{ name: "A", why: "w" }], done: [], run: "k" }, { cancelled: false }, async () => {});
    const run = log.last()!;
    expect(run.rename).toEqual({ from: "c#/intro+", to: "c#/intro" });
    expect(planUndo(run, viewOf(v, 5000)).renameBack).toEqual({ path: "c#/intro", newPath: "c#/intro+" });
    v.files.set("c#/intro/my own.md", "x");
    expect(planUndo(run, viewOf(v, 5000)).renameBack).toBeUndefined();
  });

  test("a resumed job appends to the same run", async () => {
    const { v, log, flow } = setup();
    v.folders.add("T");
    const base = { id: "r", kind: "research" as const, path: "T", run: "same" };
    await flow.run({ ...base, approved: [{ name: "A", why: "w" }], done: [] }, { cancelled: false }, async () => {});
    await flow.run({ ...base, approved: [{ name: "A", why: "w" }, { name: "B", why: "w" }], done: ["A"] }, { cancelled: false }, async () => {});
    expect(log.list()).toHaveLength(1);
    expect(log.last()!.folders.sort()).toEqual(["T/A", "T/B"]);
  });
});

describe("a PDF run records the container, entry notes and the key point notes", () => {
  test("outside a research root: the new folder is the root, key point jobs append to the same run", async () => {
    const v = new MemVault();
    v.folders.add("Docs");
    const log = new RunLog([], () => {}, () => 7000);
    const w = new VaultWriter(v);
    const written = await w.writePdfOverview({
      container: "Docs/paper", asRoot: true, pdfName: "paper.pdf", existingSubfolders: [], date: "2026-10-09",
      overview: { summary: "s", plainWords: "p", keyPoints: [{ name: "Idea", text: "t (p. 1)", detail: "d. e.", pages: "1" }] },
      rec: log.begin("pdf:Docs/paper.pdf:1", "paper.pdf", "Docs/paper"),
    });
    await w.writeKeypointNotes(written.entries[0].folder, "paper", "Idea", [note("n1")], "2026-10-09", quiz, { pdf: "paper.pdf", pages: "1" },
      log.begin("pdf:Docs/paper.pdf:1", "paper.pdf", "Docs/paper"));
    const run = log.last()!;
    expect(log.list()).toHaveLength(1);
    expect(run.root).toBe("Docs/paper");
    expect(run.folders.sort()).toEqual(["Docs/paper", "Docs/paper/Idea"]);
    expect(run.files.map((f) => f.path)).toContain("Docs/paper/paper - Overview.md");
    expect(run.files.map((f) => f.path)).toContain("Docs/paper/Idea/Idea.md");
    expect(run.files.map((f) => f.path)).toContain("Docs/paper/Idea/n1.md");
    // The PDF itself is never in the log.
    expect(run.files.map((f) => f.path)).not.toContain("Docs/paper.pdf");
    const plan = planUndo(run, viewOf(v, 7000));
    expect(plan.trash.map((t) => t.path)).toContain("Docs/paper");
    expect(plan.kept).toEqual([]);
  });

  test("a collision-safe container name is what the log records as the root", async () => {
    const v = new MemVault();
    v.folders.add("Docs"); v.folders.add("Docs/paper");
    const log = new RunLog([], () => {}, () => 1);
    await new VaultWriter(v).writePdfOverview({
      container: "Docs/paper", asRoot: true, pdfName: "paper.pdf", existingSubfolders: [], date: "d",
      overview: { summary: "s", plainWords: "p", keyPoints: [] }, rec: log.begin("k", "paper.pdf", "Docs/paper"),
    });
    expect(log.last()!.root).toBe("Docs/paper (2)");
  });
});

describe("the log is saved with the plugin data", () => {
  test("mergeData keeps valid runs (last 20), drops junk, and defaults to none", () => {
    expect(mergeData({}).runLog).toEqual([]);
    expect(mergeData({}).renames).toEqual({});
    const runs = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, at: i, label: "L", root: "R", folders: ["R/x"], files: [{ path: "R/x/a.md", at: i }] }));
    const data = mergeData({ runLog: [...runs, { key: 1 }, null, { key: "bad", at: "x", label: "L", root: "R", folders: [], files: [] }], renames: { "A/b": "A/b+", "x": 5 } });
    expect(data.runLog).toHaveLength(20);
    expect(data.runLog[0].key).toBe("k5");
    expect(data.renames).toEqual({ "A/b": "A/b+" });
  });
});
