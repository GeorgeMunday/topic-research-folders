import { beforeAll, describe, expect, test, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PdfFlow, markResumed, type PdfDeps } from "../src/flows/pdfFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { ApiError, JobQueue } from "../src/jobs/queue";
import { ParseError } from "../src/research/parse";
import { sha256 } from "../src/pdf/chunk";
import type { Job, KeyPoint, PdfOverview } from "../src/types";
import type { Settings } from "../src/settings";
import type { Progress } from "../src/types";
import { CANCELLED_MESSAGE, type ProgressSource } from "../src/progress";

const hoisted = vi.hoisted(() => ({ splitOverride: null as null | ((...a: any[]) => Promise<any>) }));
vi.mock("../src/pdf/chunk", async () => {
  const actual = await vi.importActual<typeof import("../src/pdf/chunk")>("../src/pdf/chunk");
  return {
    ...actual,
    splitPdf: (...a: Parameters<typeof actual.splitPdf>) =>
      hoisted.splitOverride ? hoisted.splitOverride(...a) : actual.splitPdf(...a),
  };
});

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

const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
async function makePdf(pages: number, tag: string): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage().drawText(`${tag} page ${i + 1}`);
  return toBuf(await doc.save());
}

let pdf1: ArrayBuffer;
let pdf120: ArrayBuffer;
let pdf3: ArrayBuffer;
let encrypted: ArrayBuffer;
let ten: ArrayBuffer[];

beforeAll(async () => {
  pdf1 = await makePdf(1, "one");
  pdf3 = await makePdf(3, "three");
  pdf120 = await makePdf(120, "big");
  const enc = await PDFDocument.create();
  enc.addPage();
  enc.context.trailerInfo.Encrypt = enc.context.register(
    enc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 }),
  );
  encrypted = toBuf(await enc.save());
  ten = [];
  for (let i = 0; i < 30; i++) ten.push(await makePdf(10, `doc${i}`));
});

const baseSettings: Settings = {
  apiKey: "k", model: "m", modelChosen: false, useWebSearch: false, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 5, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 2, maxRetries: 3,
  processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200,
};

const kp = (name: string, page = 1, subfolder?: string): KeyPoint => ({
  name, text: `${name} matters (p. ${page})`, detail: `About ${name}.`, pages: String(page), ...(subfolder ? { subfolder } : {}),
});
const ov = (...names: string[]): PdfOverview => ({ summary: "sum", plainWords: "p", keyPoints: names.map((n, i) => kp(n, i + 1)) });
/** Default merge: every chunk's key points in order, capped at 5 (like the model's top 5). */
const concat = async (_n: string, cands: PdfOverview[]): Promise<PdfOverview> =>
  ({ summary: cands.map((c) => c.summary).join(" "), plainWords: "p", keyPoints: cands.flatMap((c) => c.keyPoints).slice(0, 5) });

interface Ctx {
  flow: PdfFlow; vault: MemVault; files: Map<string, ArrayBuffer>;
  enqueued: Job[]; infos: string[]; errors: string[]; confirms: string[];
  processed: Record<string, { path: string; date: string }>;
  marked: string[]; order: string[]; renames: [string, string][];
  overview: ReturnType<typeof vi.fn>; merge: ReturnType<typeof vi.fn>; settings: Settings;
  confirmAnswer: { value: boolean | Promise<boolean> };
  readCalls: { active: number; max: number; total: number };
  client: { v: any }; writer: VaultWriter; slow: { ms: number };
}

function setup(over: Partial<Settings> = {}, ready = true): Ctx {
  const vault = new MemVault();
  vault.folders.add("Topic");
  vault.files.set("Topic/Topic - Overview.md", "---\nresearch-root: true\n---\n# Topic");
  vault.folders.add("Topic/Anatomy");
  const writer = new VaultWriter(vault);
  const realWrite = writer.writePdfOverview.bind(writer);
  const order: string[] = [];
  writer.writePdfOverview = async (...a) => { order.push("write"); return realWrite(...a); };
  const files = new Map<string, ArrayBuffer>();
  const enqueued: Job[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const confirms: string[] = [];
  const processed: Record<string, { path: string; date: string }> = {};
  const marked: string[] = [];
  const renames: [string, string][] = [];
  const settings = { ...baseSettings, ...over };
  const overview = vi.fn(async (..._a: any[]): Promise<PdfOverview> => ov("N"));
  const merge = vi.fn(concat);
  const confirmAnswer = { value: true as boolean | Promise<boolean> };
  const readCalls = { active: 0, max: 0, total: 0 };
  const client = { v: { overviewPdf: overview, mergeOverviews: merge } as any };
  const slow = { ms: 1 };
  const deps: PdfDeps = {
    client: () => client.v, writer,
    notify: { info: (m) => infos.push(m), error: (m) => errors.push(m) },
    confirm: { confirm: async (m) => { confirms.push(m); return confirmAnswer.value; } },
    readBinary: async (p) => {
      readCalls.active++; readCalls.total++;
      readCalls.max = Math.max(readCalls.max, readCalls.active);
      await new Promise((r) => setTimeout(r, slow.ms));
      readCalls.active--;
      const b = files.get(p);
      if (!b) throw new Error("ENOENT " + p);
      return b;
    },
    settings: () => settings, today: () => "2026-10-09", now: () => NOW,
    enqueue: (j) => { if (j.kind === "keypoint") order.push("enqueue"); enqueued.push(j); return true; },
    processed: () => processed,
    markProcessed: async (h, p) => { order.push("mark"); marked.push(h); processed[h] = { path: p, date: "d" }; },
    rename: async (from, to) => {
      renames.push([from, to]);
      const b = files.get(from);
      if (b) { files.delete(from); files.set(to, b); }
      const v = vault.files.get(from);
      if (v !== undefined) { vault.files.delete(from); vault.files.set(to, v); }
    },
  };
  const flow = new PdfFlow(deps);
  if (ready) flow.markReady();
  return { flow, vault, files, enqueued, infos, errors, confirms, processed, marked, order, renames, overview, merge, settings, confirmAnswer, readCalls, client, writer, slow };
}

/** Puts a PDF into the vault (listed as a sibling) and makes its bytes readable. */
const drop = (c: Ctx, path: string, bytes: ArrayBuffer) => { c.files.set(path, bytes); c.vault.files.set(path, "%PDF"); };
const noSignal = { cancelled: false };
const noCp = async () => {};
const job = (path: string): Job => ({ id: `pdf:${path}`, kind: "pdf", path });
/** The clock the test flow sees; a trigger stamps its job with it. */
const NOW = 1_000_000;
const tjob = (path: string): Job => ({ ...job(path), triggeredAt: NOW } as Job);

describe("plain PDFs are never processed", () => {
  test("a pdf created inside a research root without the suffix is ignored", async () => {
    const c = setup();
    drop(c, "Topic/a.pdf", pdf1);
    await c.flow.onFileEvent("Topic/a.pdf");
    expect(c.readCalls.total).toBe(0);
    expect(c.renames).toEqual([]);
    expect(c.enqueued).toEqual([]);
    expect([...c.errors, ...c.infos, ...c.confirms]).toEqual([]);
  });
});

describe("suffix trigger on the PDF", () => {
  test("onFileEvent: ignores events before ready; ignores non-triggers; for paper+.pdf renames to paper.pdf and enqueues a pdf job for the clean path", async () => {
    const early = setup({}, false);
    drop(early, "Topic/paper+.pdf", pdf1);
    await early.flow.onFileEvent("Topic/paper+.pdf");
    expect(early.readCalls.total).toBe(0);
    expect(early.renames).toEqual([]);
    expect(early.enqueued).toEqual([]);

    const c = setup();
    drop(c, "Topic/notes.txt+", pdf1);
    drop(c, "Topic/plain.pdf", pdf1);
    await c.flow.onFileEvent("Topic/notes.txt+");
    await c.flow.onFileEvent("Topic/plain.pdf");
    expect(c.readCalls.total).toBe(0);
    expect(c.enqueued).toEqual([]);

    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([["Topic/paper+.pdf", "Topic/paper.pdf"]]);
    expect(c.enqueued).toEqual([tjob("Topic/paper.pdf")]);
    expect([...c.errors, ...c.infos, ...c.confirms]).toEqual([]);
  });

  test("accepts paper.pdf+ too", async () => {
    const c = setup();
    drop(c, "Topic/paper.pdf+", pdf1);
    await c.flow.onFileEvent("Topic/paper.pdf+");
    expect(c.renames).toEqual([["Topic/paper.pdf+", "Topic/paper.pdf"]]);
    expect(c.enqueued).toEqual([tjob("Topic/paper.pdf")]);
  });

  test("a pdf at the vault root and outside any research root is still triggered", async () => {
    const c = setup();
    drop(c, "paper+.PDF", pdf1);
    await c.flow.onFileEvent("paper+.PDF");
    expect(c.renames).toEqual([["paper+.PDF", "paper.PDF"]]);
    expect(c.enqueued).toEqual([tjob("paper.PDF")]);
  });

  test("stripSuffix off: no rename, job for the original path", async () => {
    const c = setup({ stripSuffix: false });
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([]);
    expect(c.enqueued).toEqual([tjob("Topic/paper+.pdf")]);
  });

  test("rename collision -> 'paper (2).pdf'", async () => {
    const c = setup();
    drop(c, "Topic/Paper.pdf", pdf3);
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([["Topic/paper+.pdf", "Topic/paper (2).pdf"]]);
    expect(c.enqueued).toEqual([tjob("Topic/paper (2).pdf")]);
    // A folder with the clean name collides as well.
    c.vault.folders.add("Topic/report.pdf");
    drop(c, "Topic/report+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/report+.pdf");
    expect(c.renames.at(-1)).toEqual(["Topic/report+.pdf", "Topic/report (2).pdf"]);
  });

  test("the rename back to paper.pdf does not retrigger (no suffix) and consumeCreated-style double events enqueue once (dedupe by kind+path)", async () => {
    const c = setup();
    drop(c, "Topic/paper+.pdf", pdf1);
    // create and rename events for the same new file, arriving together
    await Promise.all([c.flow.onFileEvent("Topic/paper+.pdf"), c.flow.onFileEvent("Topic/paper+.pdf")]);
    // the rename back fires an event for the clean name
    await c.flow.onFileEvent("Topic/paper.pdf");
    // a late duplicate for the old name: the file is gone
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([["Topic/paper+.pdf", "Topic/paper.pdf"]]);
    expect(c.enqueued).toEqual([tjob("Topic/paper.pdf")]);
    expect([...c.errors, ...c.infos]).toEqual([]);
  });

  test("an unreadable or missing file at trigger time is skipped silently", async () => {
    const c = setup();
    await c.flow.onFileEvent("Topic/gone+.pdf");
    c.vault.files.set("Topic/locked+.pdf", "%PDF"); // listed, but reading fails
    await c.flow.onFileEvent("Topic/locked+.pdf");
    expect(c.enqueued).toEqual([]);
    expect(c.renames).toEqual([]);
    expect([...c.errors, ...c.infos, ...c.confirms]).toEqual([]);
    // Once readable, the same trigger works (a skipped attempt leaves nothing stuck in flight).
    c.files.set("Topic/locked+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/locked+.pdf");
    expect(c.enqueued).toEqual([tjob("Topic/locked.pdf")]);
  });

  test("an encrypted PDF is reported with the bare reason through the sink (notify without one) and not enqueued", async () => {
    const c = setup();
    const events: [string, Progress, ProgressSource][] = [];
    (c.flow as any).deps.progress = (p: string, e: Progress, src: ProgressSource) => { events.push([p, e, src]); };
    drop(c, "Topic/secret+.pdf", encrypted);
    await c.flow.onFileEvent("Topic/secret+.pdf");
    expect(c.enqueued).toEqual([]);
    expect(events.map((x) => [x[0], x[1]])).toEqual([["Topic/secret.pdf", { kind: "failed", error: "the PDF is encrypted" }]]);
    expect(events[0][2].kind).toBe("pdf");
    expect(c.errors).toEqual([]);

    const n = setup();
    drop(n, "Topic/secret+.pdf", encrypted);
    await n.flow.onFileEvent("Topic/secret+.pdf");
    expect(n.enqueued).toEqual([]);
    expect(n.errors).toEqual(["Could not analyse secret.pdf: the PDF is encrypted"]);
  });
});

describe("run", () => {
  test("chunks big PDF, passes page offsets 0/50/100 and merges results", async () => {
    const c = setup();
    c.files.set("Topic/big.pdf", pdf120);
    c.overview.mockImplementation(async (_n: string, _s: string[], _b: string, off: number) => ({
      summary: `sum${off}`, plainWords: "p", keyPoints: [kp(`Point ${off}`, off + 1)],
    }));
    await c.flow.run(job("Topic/big.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 50, 100]);
    expect(c.overview.mock.calls.map((x) => x[0])).toEqual(["big", "big", "big"]);
    expect(c.overview.mock.calls[0][1]).toEqual(["Anatomy"]);
    // Chunked: one text-only merge over every chunk's result.
    expect(c.merge).toHaveBeenCalledTimes(1);
    expect(c.merge.mock.calls[0][0]).toBe("big");
    expect(c.merge.mock.calls[0][1].map((r: PdfOverview) => r.summary)).toEqual(["sum0", "sum50", "sum100"]);
    const md = c.vault.files.get("Topic/Sources/big - Overview.md")!;
    expect(md).toContain("sum0 sum50 sum100");
    // Key point jobs carry the merged overview's summary, so Stage 2 knows what the whole PDF is about.
    expect(c.enqueued.map((j) => j.kind === "keypoint" && j.docSummary)).toEqual(["sum0 sum50 sum100", "sum0 sum50 sum100", "sum0 sum50 sum100"]);
    expect(md).toContain("Point 50 matters (p. 51)");
    expect(c.infos).toEqual([]);
  });

  test("a single chunk is used as is: no merge call", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf3);
    c.overview.mockResolvedValue(ov("Alpha", "Beta"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
    expect(c.overview.mock.calls[0][3]).toBe(0);
    expect(c.merge).not.toHaveBeenCalled();
    expect(c.enqueued.map((j) => j.kind === "keypoint" && j.point.name)).toEqual(["Alpha", "Beta"]);
  });

  test("subfolder list excludes From PDFs and Sources", async () => {
    const c = setup();
    c.vault.folders.add("Topic/From PDFs"); c.vault.folders.add("Topic/Sources");
    c.files.set("Topic/a.pdf", pdf1);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls[0][1]).toEqual(["Anatomy"]);
  });

  test("pdf run enqueues exactly 5 keypoint jobs for a 5-point overview, 2 for a 2-point one, 0 for none", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockResolvedValue({ ...ov("One", "Two", "Three", "Four", "Five"), keyPoints: [kp("One", 1, "Anatomy"), kp("Two"), kp("Three"), kp("Four"), kp("Five")] });
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.enqueued).toEqual([
      { id: "keypoint:Topic/Anatomy/One.md", kind: "keypoint", path: "Topic/Anatomy/One.md", folder: "Topic/Anatomy", pdfName: "a.pdf", topic: "a", parents: ["Topic"], docSummary: "sum", point: kp("One", 1, "Anatomy") },
      ...["Two", "Three", "Four", "Five"].map((n) => ({
        id: `keypoint:Topic/From PDFs/${n}/${n}.md`, kind: "keypoint", path: `Topic/From PDFs/${n}/${n}.md`, folder: `Topic/From PDFs/${n}`,
        pdfName: "a.pdf", topic: "a", parents: ["Topic"], docSummary: "sum", point: kp(n),
      })),
    ]);
    const two = setup();
    two.files.set("Topic/a.pdf", pdf1);
    two.overview.mockResolvedValue(ov("One", "Two"));
    await two.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(two.enqueued).toHaveLength(2);
    const none = setup();
    none.files.set("Topic/a.pdf", pdf1);
    none.overview.mockResolvedValue(ov());
    await none.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(none.enqueued).toEqual([]);
    expect(none.vault.files.has("Topic/Sources/a - Overview.md")).toBe(true);
    expect(none.marked).toHaveLength(1);
  });

  test("marks the hash processed after the overview is written and the jobs are queued (not before)", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockResolvedValue(ov("One", "Two"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.order).toEqual(["write", "enqueue", "enqueue", "mark"]);
    expect(c.marked).toEqual([await sha256(pdf1)]);
    expect(c.infos).toEqual([]);
  });

  test("outside a root the PDF stays in place and '<dir>/<stem>/' is created as a new research root; inside a root the overview lands in Sources", async () => {
    const c = setup();
    drop(c, "Docs/paper.pdf", pdf1);
    c.overview.mockResolvedValue(ov("Alpha"));
    await c.flow.run(job("Docs/paper.pdf"), noSignal, noCp);
    expect(c.renames).toEqual([]);
    expect(c.vault.files.has("Docs/paper.pdf")).toBe(true);
    expect(c.overview.mock.calls[0][1]).toEqual([]);
    expect(c.vault.files.get("Docs/paper/paper - Overview.md")).toContain("research-root: true");
    expect(c.enqueued).toEqual([{
      id: "keypoint:Docs/paper/Alpha/Alpha.md", kind: "keypoint", path: "Docs/paper/Alpha/Alpha.md", folder: "Docs/paper/Alpha",
      pdfName: "paper.pdf", topic: "paper", parents: [], docSummary: "sum", point: kp("Alpha", 1),
    }]);
    expect(await c.writer.isResearchRoot("Docs/paper")).toBe(true);

    const r = setup();
    drop(r, "Topic/Anatomy/paper.pdf", pdf1);
    await r.flow.run(job("Topic/Anatomy/paper.pdf"), noSignal, noCp);
    expect(r.vault.files.get("Topic/Sources/paper - Overview.md")).not.toContain("research-root");
    expect(r.vault.folders.has("Topic/Anatomy/paper")).toBe(false);
  });

  test("restored job with an already processed hash → silently returns without calling client", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "x", date: "d", at: NOW } as any;
    await c.flow.run({ ...job("Topic/a.pdf"), resume: true } as Job, noSignal, noCp);
    expect(c.overview).not.toHaveBeenCalled();
    expect(c.infos).toEqual([]);
  });

  test("concurrent runs of identical content process only once", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1); c.files.set("Topic/b.pdf", pdf1);
    // The first run is still analysing while the second starts (processedPdfs does not stop explicit jobs).
    c.overview.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return ov("N");
    });
    await Promise.all([c.flow.run(job("Topic/a.pdf"), noSignal, noCp), c.flow.run(job("Topic/b.pdf"), noSignal, noCp)]);
    expect(c.overview).toHaveBeenCalledTimes(1);
    expect(c.marked.length).toBe(1);
  });

  test("missing client → error notice, nothing processed", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.client.v = null;
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.errors.length).toBe(1);
    expect(c.marked).toEqual([]);
  });

  test("empty API key → error notice, nothing processed", async () => {
    const c = setup({ apiKey: "  " });
    c.files.set("Topic/a.pdf", pdf1);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.errors.length).toBe(1);
    expect(c.overview).not.toHaveBeenCalled();
  });

  test("encrypted pdf → notice naming file, job completes without throwing", async () => {
    const c = setup();
    c.files.set("Topic/secret.pdf", encrypted);
    await expect(c.flow.run(job("Topic/secret.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.errors[0]).toContain("secret.pdf");
    expect(c.overview).not.toHaveBeenCalled();
    expect(c.marked).toEqual([]);
  });

  test("oversized single page → notice lists skipped pages, rest processed", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf3);
    hoisted.splitOverride = async () => ({
      chunks: [{ base64: "QQ==", firstPage: 1, lastPage: 1 }, { base64: "Qg==", firstPage: 3, lastPage: 3 }],
      skippedPages: [2, 7],
    });
    try {
      await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    } finally { hoisted.splitOverride = null; }
    expect([...c.errors, ...c.infos].some((m) => m.includes("a.pdf") && m.includes("2") && m.includes("7"))).toBe(true);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 2]);
    expect(c.marked.length).toBe(1);
  });

  test("pdf deleted before its job runs → silently skipped", async () => {
    const c = setup();
    await expect(c.flow.run(job("Topic/gone.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.errors).toEqual([]);
    expect(c.infos).toEqual([]);
    expect(c.overview).not.toHaveBeenCalled();
  });

  test("retryable ApiError propagates and marks nothing", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockRejectedValue(new ApiError("overloaded", 529));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(c.marked).toEqual([]);
    // inFlight must be cleared so the retry can run
    c.overview.mockResolvedValue(ov());
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(2);
  });

  test("a network TypeError from overviewPdf propagates (retryable)", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockRejectedValue(new TypeError("offline"));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(TypeError);
    expect(c.marked).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  test("non-retryable error → notice, nothing processed, no throw", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockRejectedValue(new ApiError("bad request", 400));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.errors.length).toBe(1);
    expect(c.marked).toEqual([]);
    expect(c.order).toEqual([]);
  });
});

describe("fix round 1", () => {
  test("run stops when cancelled between chunks", async () => {
    const c = setup();
    c.files.set("Topic/big.pdf", pdf120);
    const sig = { cancelled: false };
    c.overview.mockImplementation(async () => { sig.cancelled = true; return ov("N"); });
    await c.flow.run(job("Topic/big.pdf"), sig, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
    expect(c.order).toEqual([]);
    expect(c.marked).toEqual([]);
  });

  test("cancel mid-way writes nothing: cancelled while the chunks are merged -> no overview, no folders, no jobs", async () => {
    const c = setup();
    c.files.set("Topic/big.pdf", pdf120);
    const before = new Set([...c.vault.files.keys(), ...c.vault.folders]);
    const sig = { cancelled: false };
    c.merge.mockImplementation(async (n: string, cands: PdfOverview[]) => { sig.cancelled = true; return concat(n, cands); });
    await c.flow.run(job("Topic/big.pdf"), sig, noCp);
    expect(c.merge).toHaveBeenCalledTimes(1);
    expect(c.order).toEqual([]);
    expect(c.enqueued).toEqual([]);
    expect(c.marked).toEqual([]);
    expect(new Set([...c.vault.files.keys(), ...c.vault.folders])).toEqual(before);
  });
});

describe("chunk cache", () => {
  const chunkSetup = () => {
    const c = setup({ pdfPagesPerChunk: 1 });
    c.files.set("Topic/a.pdf", pdf3);
    return c;
  };
  const impl = (c: Ctx, failAt: number, err: () => Error) => {
    let failed = false;
    c.overview.mockImplementation(async (...a: any[]): Promise<PdfOverview> => {
      const off = a[3] as number;
      if (off === failAt && !failed) { failed = true; throw err(); }
      return { summary: "sum", plainWords: "p", keyPoints: [kp(`N${off}`, off + 1)] };
    });
  };
  const queueFor = (c: Ctx) => new JobQueue(c.flow.run, {
    maxConcurrent: () => 1, maxRetries: () => 3,
    persist: async () => {}, sleep: async () => {}, rand: () => 0.5,
    onChange: () => {}, onFailed: () => {},
  });

  test("retry after a retryable error on chunk 2 does not resend chunk 1; result merges all chunks", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("overloaded", 503));
    const q = queueFor(c);
    q.add(job("Topic/a.pdf"));
    await q.idle();
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 1, 2]);
    expect(c.marked.length).toBe(1);
    for (const t of ["N0", "N1", "N2"]) expect(c.vault.files.has(`Topic/From PDFs/${t}/${t}.md`)).toBe(true);
  });

  test("a retryable error in stage 1 does not resend finished chunks and does not enqueue jobs twice (chunk and merge failures)", async () => {
    const c = chunkSetup();
    impl(c, 2, () => new ApiError("rate limited", 429));
    let mergeFailed = false;
    c.merge.mockImplementation(async (n: string, cands: PdfOverview[]) => {
      if (!mergeFailed) { mergeFailed = true; throw new ApiError("overloaded", 529); }
      return concat(n, cands);
    });
    const q = queueFor(c);
    q.add(job("Topic/a.pdf"));
    await q.idle();
    // chunk 3 failed once; then the merge failed once: neither retry resent a finished chunk.
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2, 2]);
    expect(c.merge).toHaveBeenCalledTimes(2);
    expect(c.order.filter((o) => o === "write")).toEqual(["write"]);
    expect(c.enqueued.filter((j) => j.kind === "keypoint").map((j) => j.path)).toEqual(
      ["N0", "N1", "N2"].map((t) => `Topic/From PDFs/${t}/${t}.md`));
    expect(c.marked.length).toBe(1);
  });

  test("a failing markProcessed after the jobs were queued does not retry the run (no second overview, no duplicate jobs)", async () => {
    const c = chunkSetup();
    (c.flow as any).deps.markProcessed = async () => { throw new ApiError("disk busy", 503); };
    const q = queueFor(c);
    q.add(job("Topic/a.pdf"));
    await q.idle();
    expect(c.order.filter((o) => o === "write")).toEqual(["write"]);
    expect(c.enqueued.filter((j) => j.kind === "keypoint")).toHaveLength(3);
  });

  test("cache is cleared after success: re-running the same bytes re-extracts every chunk", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("overloaded", 503));
    const q = queueFor(c);
    q.add(job("Topic/a.pdf"));
    await q.idle();
    c.overview.mockClear();
    delete c.processed[await sha256(pdf3)];
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("cache is cleared on non-retryable failure", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("bad request", 400));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1]);
    c.overview.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("cache is cleared on cancellation", async () => {
    const c = chunkSetup();
    const sig = { cancelled: false };
    c.overview.mockImplementation(async (...a: any[]) => {
      if (a[3] === 1) sig.cancelled = true;
      return ov(`N${a[3]}`);
    });
    await c.flow.run(job("Topic/a.pdf"), sig, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1]);
    c.overview.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("dropCache(path) forgets chunks of a job the queue gave up on", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("overloaded", 503));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    c.flow.dropCache("Topic/a.pdf");
    c.overview.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });
});

describe("progress events", () => {
  type Ev = [string, Progress, ProgressSource];
  function withSink() {
    const c = setup();
    const events: Ev[] = [];
    (c.flow as any).deps.progress = (p: string, e: Progress, src: ProgressSource) => { events.push([p, e, src]); };
    return { c, events, kinds: () => events.map((x) => x[1]) };
  }

  test("3-chunk pdf emits 'Preparing…', chunk 1/3, 2/3, 3/3, the merge step, then done with the key point count", async () => {
    const { c, events, kinds } = withSink();
    c.settings.pdfPagesPerChunk = 1;
    c.files.set("Topic/a.pdf", pdf3);
    c.overview.mockImplementation(async (...a: any[]) => ov(`N${a[3]}`));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(kinds()).toEqual([
      { kind: "step", text: "Preparing a.pdf…" },
      { kind: "step", text: "Analysing a.pdf (chunk 1/3)…" },
      { kind: "step", text: "Analysing a.pdf (chunk 2/3)…" },
      { kind: "step", text: "Analysing a.pdf (chunk 3/3)…" },
      { kind: "step", text: "Picking the top 5 key points…" },
      { kind: "done", folders: 3, notes: 1 },
    ]);
    expect(events.every((e) => e[0] === "Topic/a.pdf" && e[2].kind === "pdf" && e[2].resumed === false)).toBe(true);
    expect(c.infos).toEqual([]); // with a sink the hub shows the notice
  });

  test("encrypted pdf emits failed after the preparing step; cancelled pdf emits failed CANCELLED_MESSAGE", async () => {
    const e1 = withSink();
    e1.c.files.set("Topic/secret.pdf", encrypted);
    await e1.c.flow.run(job("Topic/secret.pdf"), noSignal, noCp);
    expect(e1.kinds()).toEqual([
      { kind: "step", text: "Preparing secret.pdf…" },
      { kind: "failed", error: "the PDF is encrypted" },
    ]);
    expect(e1.c.errors).toEqual([]); // with a sink the hub shows the notice

    const e2 = withSink();
    e2.c.settings.pdfPagesPerChunk = 1;
    e2.c.files.set("Topic/a.pdf", pdf3);
    const sig = { cancelled: false };
    e2.c.overview.mockImplementation(async () => { sig.cancelled = true; return ov(); });
    await e2.c.flow.run(job("Topic/a.pdf"), sig, noCp);
    expect(e2.kinds().at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
    expect(e2.kinds().filter((e) => e.kind === "failed" || e.kind === "done")).toHaveLength(1);
  });

  test("silent failure exits still emit failed after the first step", async () => {
    const a = withSink();
    a.c.files.set("Topic/a.pdf", pdf1);
    a.c.client.v = null;
    await a.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(a.kinds()).toEqual([
      { kind: "step", text: "Preparing a.pdf…" },
      { kind: "failed", error: "no Claude API key — add it in the plugin settings" },
    ]);

    // A PDF outside any research root is no longer a failure: it gets its own folder.
    const b = withSink();
    b.c.files.set("Other/a.pdf", pdf1);
    await b.c.flow.run(job("Other/a.pdf"), noSignal, noCp);
    expect(b.kinds().at(-1)).toEqual({ kind: "done", folders: 1, notes: 1 });

    const d = withSink();
    d.c.files.set("Topic/a.pdf", pdf1);
    d.c.overview.mockRejectedValue(new ApiError("bad request", 400));
    await d.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(d.kinds().at(-1)).toEqual({ kind: "failed", error: "bad request" });
  });

  test("restored, already processed pdf emits nothing", async () => {
    const { c, events } = withSink();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "x", date: "d", at: NOW } as any;
    await c.flow.run({ ...job("Topic/a.pdf"), resume: true } as Job, noSignal, noCp);
    expect(events).toEqual([]);
  });

  test("retryable chunk error emits the retry step and rethrows", async () => {
    const { c, kinds } = withSink();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockRejectedValue(new ApiError("overloaded", 529));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(kinds().at(-1)).toEqual({ kind: "step", text: "Retrying a.pdf after a temporary error…" });
    expect(kinds().some((e) => e.kind === "failed" || e.kind === "done")).toBe(false);
  });
});

describe("pdf run identity", () => {
  test("events of one run share a runId and a second run gets a new one", async () => {
    const c = setup();
    const events: [string, Progress, ProgressSource][] = [];
    (c.flow as any).deps.progress = (p: string, e: Progress, src: ProgressSource) => { events.push([p, e, src]); };
    c.files.set("Topic/secret.pdf", encrypted);
    await c.flow.run(job("Topic/secret.pdf"), noSignal, noCp);
    const n = events.length;
    await c.flow.run(job("Topic/secret.pdf"), noSignal, noCp);
    const a = new Set(events.slice(0, n).map((x) => x[2].runId));
    const b = new Set(events.slice(n).map((x) => x[2].runId));
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).not.toBe([...b][0]);
    expect(typeof [...a][0]).toBe("number");
  });
});

describe("pdf run identity after cancel and across flows", () => {
  test("a retryable error after a cancel leaves no retry entry: the next run gets a new runId", async () => {
    const c = setup();
    const events: [string, Progress, ProgressSource][] = [];
    (c.flow as any).deps.progress = (p: string, e: Progress, src: ProgressSource) => { events.push([p, e, src]); };
    c.files.set("Topic/a.pdf", pdf3);
    const sig = { cancelled: false };
    c.overview.mockImplementation(async () => { sig.cancelled = true; throw new ApiError("overloaded", 503); });
    await expect(c.flow.run(job("Topic/a.pdf"), sig, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(events.some((x) => x[1].kind === "step" && x[1].text.startsWith("Retrying"))).toBe(false);
    const first = events[0][2].runId;
    c.overview.mockReset();
    c.files.set("Topic/b.pdf", pdf3);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp).catch(() => {});
    expect(events.at(-1)![2].runId).not.toBe(first);
  });
  test("run ids from a research flow and a pdf flow never collide", async () => {
    const c = setup();
    const ev: ProgressSource[] = [];
    (c.flow as any).deps.progress = (_p: string, _e: Progress, src: ProgressSource) => { ev.push(src); };
    c.files.set("Topic/a.pdf", pdf3);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp).catch(() => {});
    const { nextRunId } = await import("../src/progress");
    const other = nextRunId();
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((s) => s.runId !== other)).toBe(true);
    expect(other).toBeGreaterThan(Math.max(...ev.map((s) => s.runId!)));
  });
});

describe("pdf pre-cancel", () => {
  test("a pre-cancelled signal makes no API call and emits nothing", async () => {
    const c = setup();
    const events: Progress[] = [];
    (c.flow as any).deps.progress = (_p: string, e: Progress) => { events.push(e); };
    c.files.set("Topic/a.pdf", pdf3);
    await c.flow.run(job("Topic/a.pdf"), { cancelled: true }, noCp);
    expect(c.overview).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("Task 16: outcomes go only through the sink when one exists", () => {
  function withSink() {
    const c = setup();
    const events: Progress[] = [];
    (c.flow as any).deps.progress = (_p: string, e: Progress) => { events.push(e); };
    return { c, events };
  }

  test("with a sink, no notify call is made for failed exits or success; without a sink notify is used as before", async () => {
    // missing key
    const a = withSink(); a.c.files.set("Topic/a.pdf", pdf1); a.c.client.v = null;
    await a.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(a.events.at(-1)).toMatchObject({ kind: "failed" });
    expect([...a.c.errors, ...a.c.infos]).toEqual([]);
    // encrypted
    const b = withSink(); b.c.files.set("Topic/s.pdf", encrypted);
    await b.c.flow.run(job("Topic/s.pdf"), noSignal, noCp);
    expect(b.events.at(-1)).toEqual({ kind: "failed", error: "the PDF is encrypted" });
    expect([...b.c.errors, ...b.c.infos]).toEqual([]);
    // non-retryable chunk error
    const d = withSink(); d.c.files.set("Topic/a.pdf", pdf1); d.c.overview.mockRejectedValue(new ApiError("bad request", 400));
    await d.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(d.events.at(-1)).toEqual({ kind: "failed", error: "bad request" });
    expect([...d.c.errors, ...d.c.infos]).toEqual([]);
    // success
    const e = withSink(); e.c.files.set("Topic/a.pdf", pdf1);
    await e.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(e.events.at(-1)).toMatchObject({ kind: "done" });
    expect([...e.c.errors, ...e.c.infos]).toEqual([]);

    // without a sink: unchanged
    const na = setup(); na.files.set("Topic/a.pdf", pdf1); na.client.v = null;
    await na.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(na.errors).toEqual(["Add your Claude API key in the plugin settings before analysing PDFs."]);
    const nb = setup(); nb.files.set("Topic/s.pdf", encrypted);
    await nb.flow.run(job("Topic/s.pdf"), noSignal, noCp);
    expect(nb.errors).toEqual(["Could not analyse s.pdf: the PDF is encrypted"]);
    const nd = setup(); nd.files.set("Topic/a.pdf", pdf1); nd.overview.mockRejectedValue(new ApiError("bad request", 400));
    await nd.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(nd.errors).toEqual(["Could not analyse a.pdf: bad request"]);
    // Success has no flow notice any more: the hub turns `done` into "Overview ready…".
    const ne = setup(); ne.files.set("Topic/a.pdf", pdf1);
    await ne.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect([...ne.infos, ...ne.errors]).toEqual([]);
    expect(ne.marked).toHaveLength(1);
  });
});

describe("fix round 1: pdf failure notices carry one prefix", () => {
  test("hub-level: an encrypted PDF gives exactly 'Could not analyse s.pdf: the PDF is encrypted'; a missing key and an API error read cleanly too", async () => {
    const { ProgressHub } = await import("../src/ui/hub");
    const notices: string[] = [];
    const hub = new ProgressHub(
      { notice: (t) => { notices.push(t); }, setStatus: () => {}, setSpinners: () => {}, reviewModal: async () => null },
      { startApproved: () => true, pathExists: () => true, persistPending: () => {} },
    );
    const a = setup(); (a.flow as any).deps.progress = hub.sink; a.files.set("Topic/s.pdf", encrypted);
    await a.flow.run(job("Topic/s.pdf"), noSignal, noCp);
    const b = setup(); (b.flow as any).deps.progress = hub.sink; b.files.set("Topic/k.pdf", pdf1); b.client.v = null;
    await b.flow.run(job("Topic/k.pdf"), noSignal, noCp);
    const c = setup(); (c.flow as any).deps.progress = hub.sink; c.files.set("Topic/e.pdf", pdf1); c.overview.mockRejectedValue(new ApiError("bad request", 400));
    await c.flow.run(job("Topic/e.pdf"), noSignal, noCp);
    expect(notices).toEqual([
      "Could not analyse s.pdf: the PDF is encrypted",
      "Could not analyse k.pdf: no Claude API key — add it in the plugin settings",
      "Could not analyse e.pdf: bad request",
    ]);
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
  });
});

describe("where PDF output goes", () => {
  test("plan: a pdf inside a research root -> the root itself (not a new root), with the root's topic info", async () => {
    const c = setup();
    expect(await c.flow.plan("Topic/Anatomy/paper.pdf")).toEqual({
      container: "Topic", asRoot: false, root: { root: "Topic", topic: "Topic", parents: [] },
    });
  });

  test("plan: a pdf outside any root -> '<dir>/<stem>' as a new research root; a vault-root pdf -> '<stem>'", async () => {
    const c = setup();
    expect(await c.flow.plan("Docs/paper.pdf")).toEqual({ container: "Docs/paper", asRoot: true, root: null });
    expect(await c.flow.plan("paper.PDF")).toEqual({ container: "paper", asRoot: true, root: null });
  });

  test("run decides the case through plan(): inside a root the overview goes to Sources; outside a root to '<dir>/<stem>' (collision-safe)", async () => {
    const c = setup();
    const planned: string[] = [];
    const real = c.flow.plan.bind(c.flow);
    c.flow.plan = async (p: string) => { planned.push(p); return real(p); };
    drop(c, "Topic/a.pdf", pdf1);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.vault.files.has("Topic/Sources/a - Overview.md")).toBe(true);
    c.vault.folders.add("Docs/b");
    drop(c, "Docs/b.pdf", pdf3);
    await c.flow.run(job("Docs/b.pdf"), noSignal, noCp);
    expect(c.vault.files.get("Docs/b (2)/b - Overview.md")).toContain("research-root: true");
    expect(c.errors).toEqual([]);
    expect(planned).toEqual(["Topic/a.pdf", "Docs/b.pdf"]);
  });
});

describe("explicit triggers and one-by-one confirmation", () => {
  test("explicit trigger runs even if the hash is in processedPdfs", async () => {
    const c = setup();
    c.processed[await sha256(pdf1)] = { path: "Topic/old.pdf", date: "d" };
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.enqueued).toEqual([tjob("Topic/paper.pdf")]);
    await c.flow.run(c.enqueued[0], noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
    expect(c.vault.files.has("Topic/Sources/paper - Overview.md")).toBe(true);
    expect(c.marked).toEqual([await sha256(pdf1)]);
  });

  test("a restored pdf job (resume: true) whose hash is already processed is skipped", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.files.set("Topic/b.pdf", pdf3);
    c.processed[await sha256(pdf1)] = { path: "Topic/a.pdf", date: "d", at: NOW } as any;
    const research: Job = { id: "research:T", kind: "research", path: "T", done: [] };
    // What main does with data.json jobs before queue.restore.
    const restored = markResumed([job("Topic/a.pdf"), job("Topic/b.pdf"), research]);
    expect(restored).toEqual([{ ...job("Topic/a.pdf"), resume: true }, { ...job("Topic/b.pdf"), resume: true }, research]);
    await c.flow.run(restored[0], noSignal, noCp);
    expect(c.overview).not.toHaveBeenCalled();
    expect([...c.infos, ...c.errors]).toEqual([]);
    // A restored job that never finished still runs.
    await c.flow.run(restored[1], noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
  });

  test("a single pdf over confirmAbovePages asks once; declined enqueues nothing but the file is still renamed back; under the limit never asks", async () => {
    const c = setup({ confirmAbovePages: 9 });
    c.confirmAnswer.value = false;
    drop(c, "Topic/big+.pdf", ten[0]);
    await c.flow.onFileEvent("Topic/big+.pdf");
    expect(c.confirms).toHaveLength(1);
    expect(c.confirms[0]).toContain("big.pdf");
    expect(c.confirms[0]).toContain("10 pages");
    expect(c.renames).toEqual([["Topic/big+.pdf", "Topic/big.pdf"]]);
    expect(c.enqueued).toEqual([]);
    expect([...c.errors, ...c.infos]).toEqual([]);

    const u = setup({ confirmAbovePages: 10 });
    drop(u, "Topic/even+.pdf", ten[1]);
    await u.flow.onFileEvent("Topic/even+.pdf");
    expect(u.confirms).toEqual([]);
    expect(u.enqueued).toEqual([tjob("Topic/even.pdf")]);
  });

  test("two PDFs triggered back to back are not batched: each is handled on its own (no timer dependency)", async () => {
    const c = setup({ confirmAbovePages: 5 });
    const answers = [false, true];
    (c.flow as any).deps.confirm = { confirm: async (m: string) => { c.confirms.push(m); return answers.shift()!; } };
    drop(c, "Topic/one+.pdf", ten[0]);
    drop(c, "Topic/two+.pdf", ten[1]);
    await c.flow.onFileEvent("Topic/one+.pdf");
    await c.flow.onFileEvent("Topic/two+.pdf");
    expect(c.confirms).toHaveLength(2);
    expect(c.confirms[0]).toContain("one.pdf");
    expect(c.confirms[1]).toContain("two.pdf");
    expect(c.confirms.every((m) => m.includes("10 pages") && !m.includes("20"))).toBe(true);
    expect(c.enqueued).toEqual([tjob("Topic/two.pdf")]);
    expect("setTimer" in (c.flow as any).deps).toBe(false);
  });
});

describe("fix round 1: the plugin's own rename never retriggers", () => {
  // Obsidian fires a rename event for the new path while the plugin renames the file.
  function withRenameEvents(c: Ctx) {
    const pending: Promise<void>[] = [];
    const deps = (c.flow as any).deps;
    const real = deps.rename;
    deps.rename = async (from: string, to: string) => { await real(from, to); pending.push(c.flow.onFileEvent(to)); };
    return async () => { while (pending.length) await pending.shift(); };
  }

  test("C++.pdf is renamed exactly once to C+.pdf and enqueues exactly one job for C+.pdf; a later genuine event for that path is honoured", async () => {
    const c = setup();
    const settle = withRenameEvents(c);
    drop(c, "Topic/C++.pdf", pdf1);
    await c.flow.onFileEvent("Topic/C++.pdf");
    await settle();
    expect(c.renames).toEqual([["Topic/C++.pdf", "Topic/C+.pdf"]]);
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/C+.pdf"]);
    // The user renames something to C+.pdf later: the remembered rename was consumed once, so this one counts.
    await c.flow.onFileEvent("Topic/C+.pdf");
    await settle();
    expect(c.renames.at(-1)).toEqual(["Topic/C+.pdf", "Topic/C.pdf"]);
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/C+.pdf", "Topic/C.pdf"]);
  });

  test("paper+.pdf+ ends as paper+.pdf after one rename with one job", async () => {
    const c = setup();
    const settle = withRenameEvents(c);
    drop(c, "Topic/paper+.pdf+", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf+");
    await settle();
    expect(c.renames).toEqual([["Topic/paper+.pdf+", "Topic/paper+.pdf"]]);
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/paper+.pdf"]);
  });

  test("stripSuffix off is unaffected: no rename, one job for the original name", async () => {
    const c = setup({ stripSuffix: false });
    const settle = withRenameEvents(c);
    drop(c, "Topic/C++.pdf", pdf1);
    await c.flow.onFileEvent("Topic/C++.pdf");
    await settle();
    expect(c.renames).toEqual([]);
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/C++.pdf"]);
  });

  test("a failed rename forgets the remembered path", async () => {
    const c = setup();
    (c.flow as any).deps.rename = async () => { throw new Error("locked"); };
    drop(c, "Topic/C++.pdf", pdf1);
    await c.flow.onFileEvent("Topic/C++.pdf");
    expect(c.enqueued).toEqual([]);
    // A real file later named C+.pdf is a trigger again.
    (c.flow as any).deps.rename = async (from: string, to: string) => { c.renames.push([from, to]); };
    drop(c, "Topic/C+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/C+.pdf");
    expect(c.renames).toEqual([["Topic/C+.pdf", "Topic/C.pdf"]]);
  });
});

describe("fix round 1: a restored job is skipped only if it finished after it was triggered", () => {
  const restoredJob = (path: string, triggeredAt: number): Job => ({ ...job(path), resume: true, triggeredAt } as Job);

  test("processed last month (at < triggeredAt) + restored job -> runs", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "Topic/a.pdf", date: "d", at: NOW - 30 * 86_400_000 } as any;
    await c.flow.run(restoredJob("Topic/a.pdf", NOW), noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
  });

  test("processed after the trigger (finished, then the app closed before the queue saved) + restored job -> skipped", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "Topic/a.pdf", date: "d", at: NOW + 5000 } as any;
    await c.flow.run(restoredJob("Topic/a.pdf", NOW), noSignal, noCp);
    expect(c.overview).not.toHaveBeenCalled();
    expect([...c.infos, ...c.errors]).toEqual([]);
  });

  test("an old processed entry without 'at' never causes a skip", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "Topic/a.pdf", date: "d" };
    await c.flow.run(restoredJob("Topic/a.pdf", NOW), noSignal, noCp);
    expect(c.overview).toHaveBeenCalledTimes(1);
  });

  test("a trigger stamps its job with triggeredAt", async () => {
    const c = setup();
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.enqueued).toEqual([{ id: "pdf:Topic/paper.pdf", kind: "pdf", path: "Topic/paper.pdf", triggeredAt: NOW }]);
  });
});

describe("fix round 1: triggers are handled one after another", () => {
  const tick = () => new Promise((r) => setTimeout(r, 15));

  test("readBinary never overlaps for several simultaneous trigger events", async () => {
    const c = setup();
    c.slow.ms = 5;
    const names = ["a", "b", "c", "d", "e"];
    names.forEach((n, i) => drop(c, `Topic/${n}+.pdf`, ten[i]));
    await Promise.all(names.map((n) => c.flow.onFileEvent(`Topic/${n}+.pdf`)));
    expect(c.readCalls.total).toBe(5);
    expect(c.readCalls.max).toBe(1);
    expect(c.enqueued.map((j) => j.path)).toEqual(names.map((n) => `Topic/${n}.pdf`));
  });

  test("confirms are asked one at a time: the second only after the first is answered", async () => {
    const c = setup({ confirmAbovePages: 5 });
    const answers: Array<(v: boolean) => void> = [];
    (c.flow as any).deps.confirm = { confirm: (m: string) => { c.confirms.push(m); return new Promise<boolean>((r) => answers.push(r)); } };
    drop(c, "Topic/one+.pdf", ten[0]);
    drop(c, "Topic/two+.pdf", ten[1]);
    const both = Promise.all([c.flow.onFileEvent("Topic/one+.pdf"), c.flow.onFileEvent("Topic/two+.pdf")]);
    await tick();
    expect(c.confirms).toHaveLength(1);
    expect(c.confirms[0]).toContain("one.pdf");
    answers[0](true);
    await tick();
    expect(c.confirms).toHaveLength(2);
    expect(c.confirms[1]).toContain("two.pdf");
    answers[1](false);
    await both;
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/one.pdf"]);
  });

  test("a throwing rename is reported once via the sink, queues nothing, and the next trigger still runs", async () => {
    const c = setup();
    const events: [string, Progress][] = [];
    (c.flow as any).deps.progress = (p: string, e: Progress) => { events.push([p, e]); };
    const real = (c.flow as any).deps.rename;
    (c.flow as any).deps.rename = async (from: string, to: string) => {
      if (from === "Topic/bad+.pdf") throw new Error("the file is locked");
      return real(from, to);
    };
    drop(c, "Topic/bad+.pdf", pdf1);
    drop(c, "Topic/ok+.pdf", pdf3);
    await Promise.all([c.flow.onFileEvent("Topic/bad+.pdf"), c.flow.onFileEvent("Topic/ok+.pdf")]);
    expect(events).toEqual([["Topic/bad+.pdf", { kind: "failed", error: "the file is locked" }]]);
    expect(c.enqueued.map((j) => j.path)).toEqual(["Topic/ok.pdf"]);
    expect([...c.errors, ...c.infos]).toEqual([]);
  });
});

describe("fix round 1: trigger-time failures through the real hub", () => {
  test("an encrypted PDF trigger shows exactly one notice 'Could not analyse secret.pdf: the PDF is encrypted' and leaves no spinner", async () => {
    const { ProgressHub } = await import("../src/ui/hub");
    const notices: string[] = [];
    const spinners: string[][] = [];
    const hub = new ProgressHub(
      { notice: (t) => { notices.push(t); }, setStatus: () => {}, setSpinners: (p) => { spinners.push([...p]); }, reviewModal: async () => null },
      { startApproved: () => true, pathExists: () => true, persistPending: () => {} },
    );
    const c = setup();
    (c.flow as any).deps.progress = hub.sink;
    drop(c, "Topic/secret+.pdf", encrypted);
    await c.flow.onFileEvent("Topic/secret+.pdf");
    expect(notices).toEqual(["Could not analyse secret.pdf: the PDF is encrypted"]);
    expect(spinners.length === 0 || spinners.at(-1)!.length === 0).toBe(true);
    expect(c.enqueued).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  test("the encrypted reason reads the same at trigger time and at run time", async () => {
    const t: Progress[] = [];
    const a = setup();
    (a.flow as any).deps.progress = (_p: string, e: Progress) => { t.push(e); };
    drop(a, "Topic/s+.pdf", encrypted);
    await a.flow.onFileEvent("Topic/s+.pdf");
    const r: Progress[] = [];
    const b = setup();
    (b.flow as any).deps.progress = (_p: string, e: Progress) => { r.push(e); };
    b.files.set("Topic/s.pdf", encrypted);
    await b.flow.run(job("Topic/s.pdf"), noSignal, noCp);
    expect(t.at(-1)).toEqual(r.at(-1));
  });
});

describe("Task 18 fix round 1: stage 1 robustness", () => {
  function withSink(over: Partial<Settings> = {}) {
    const c = setup(over);
    const events: Progress[] = [];
    (c.flow as any).deps.progress = (_p: string, e: Progress) => { events.push(e); };
    return { c, events };
  }

  test("a cancel that lands while the overview is written queues no key point jobs and marks nothing", async () => {
    const { c, events } = withSink();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockResolvedValue(ov("One", "Two"));
    const sig = { cancelled: false };
    const real = c.writer.writePdfOverview;
    c.writer.writePdfOverview = async (...a) => { const r = await real(...a); sig.cancelled = true; return r; };
    await c.flow.run(job("Topic/a.pdf"), sig, noCp);
    expect(c.enqueued).toEqual([]);
    expect(c.marked).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "failed", error: CANCELLED_MESSAGE });
  });

  test("the hash is marked processed only when every key point job was accepted by the queue", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.overview.mockResolvedValue(ov("One", "Two"));
    let n = 0;
    (c.flow as any).deps.enqueue = (j: Job) => { c.enqueued.push(j); return ++n !== 2; };
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.enqueued).toHaveLength(2);
    expect(c.marked).toEqual([]);
    expect([...c.errors, ...c.infos]).toEqual([]);
  });

  test("a write error is not retried (writes are not idempotent): failed with the bare reason, no rethrow, chunk cache cleared", async () => {
    const { c, events } = withSink({ pdfPagesPerChunk: 1 });
    c.files.set("Topic/a.pdf", pdf3);
    c.overview.mockImplementation(async (...a: any[]) => ov(`N${a[3]}`));
    const real = c.writer.writePdfOverview;
    let fails = 1;
    c.writer.writePdfOverview = async (...a) => { if (fails-- > 0) throw new ApiError("vault busy", 503); return real(...a); };
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ kind: "failed", error: "vault busy" });
    expect(c.enqueued).toEqual([]);
    c.overview.mockClear();
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("stripSuffix off: container, topic and overview title use the clean stem (no trailing suffix); the source link names the real file", async () => {
    const c = setup({ stripSuffix: false });
    drop(c, "Docs/paper+.pdf", pdf1);
    c.overview.mockResolvedValue(ov("Alpha"));
    await c.flow.run(job("Docs/paper+.pdf"), noSignal, noCp);
    expect(c.overview.mock.calls[0][0]).toBe("paper");
    const md = c.vault.files.get("Docs/paper/paper - Overview.md")!;
    expect(md).toContain("# paper - Overview");
    expect(md).toContain('topic: "paper"');
    expect(md).toContain('source: "[[paper+.pdf]]"');
    expect(c.enqueued).toMatchObject([{ kind: "keypoint", folder: "Docs/paper/Alpha", topic: "paper", pdfName: "paper+.pdf" }]);
    const r = setup({ stripSuffix: false });
    drop(r, "Topic/notes.pdf+", pdf1);
    await r.flow.run(job("Topic/notes.pdf+"), noSignal, noCp);
    expect(r.vault.files.has("Topic/Sources/notes - Overview.md")).toBe(true);
  });

  test("several chunks: empty chunk results are skipped as merge candidates; one non-empty result is used without a merge", async () => {
    const c = setup({ pdfPagesPerChunk: 1 });
    c.files.set("Topic/a.pdf", pdf3);
    const results = [ov("A"), { ...ov(), summary: "" }, ov("C")];
    c.overview.mockImplementation(async (...a: any[]) => results[a[3]]);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.merge).toHaveBeenCalledTimes(1);
    expect(c.merge.mock.calls[0][1].map((r: PdfOverview) => r.keyPoints[0].name)).toEqual(["A", "C"]);

    const one = setup({ pdfPagesPerChunk: 1 });
    one.files.set("Topic/a.pdf", pdf3);
    const res1 = [{ ...ov(), summary: "" }, ov("Only"), { ...ov(), summary: "tail" }];
    one.overview.mockImplementation(async (...a: any[]) => res1[a[3]]);
    await one.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(one.merge).not.toHaveBeenCalled();
    expect(one.enqueued.map((j) => j.kind === "keypoint" && j.point.name)).toEqual(["Only"]);

    const none = setup({ pdfPagesPerChunk: 1 });
    none.files.set("Topic/a.pdf", pdf3);
    const res0 = [{ ...ov(), summary: "" }, { ...ov(), summary: "Second part." }, ov()];
    none.overview.mockImplementation(async (...a: any[]) => res0[a[3]]);
    await none.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(none.merge).not.toHaveBeenCalled();
    expect(none.enqueued).toEqual([]);
    expect(none.vault.files.get("Topic/Sources/a - Overview.md")).toContain("> Second part.");
  });

  test("a merge that returns unparseable JSON falls back to the first 5 candidate points in chunk order with the first non-empty summary", async () => {
    const c = setup({ pdfPagesPerChunk: 1 });
    c.files.set("Topic/a.pdf", pdf3);
    const results = [{ ...ov("A", "B", "C"), summary: "" }, { ...ov("D", "E", "F"), summary: "Middle." }, ov("G")];
    c.overview.mockImplementation(async (...a: any[]) => results[a[3]]);
    c.merge.mockRejectedValue(new ParseError("Invalid JSON"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.enqueued.map((j) => j.kind === "keypoint" && j.point.name)).toEqual(["A", "B", "C", "D", "E"]);
    expect(c.vault.files.get("Topic/Sources/a - Overview.md")).toContain("> Middle.");
    expect(c.errors).toEqual([]);
  });
});
