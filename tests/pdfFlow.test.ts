import { beforeAll, describe, expect, test, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PdfFlow, type PdfDeps } from "../src/flows/pdfFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { ApiError, JobQueue } from "../src/jobs/queue";
import { sha256 } from "../src/pdf/chunk";
import type { Job, PdfExtraction, ExtractedNote } from "../src/types";
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

const note = (subfolder: string, title: string, keyPoints: string[], pages: string, summary = "s"): ExtractedNote => ({
  subfolder, title, summary, keyPoints, plainWords: "p", isNew: false, pages,
});

interface Ctx {
  flow: PdfFlow; vault: MemVault; files: Map<string, ArrayBuffer>;
  enqueued: Job[]; infos: string[]; errors: string[]; confirms: string[];
  processed: Record<string, { path: string; date: string }>;
  marked: string[]; order: string[]; renames: [string, string][];
  extract: ReturnType<typeof vi.fn>; settings: Settings;
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
  const realWrite = writer.writeExtracted.bind(writer);
  const order: string[] = [];
  writer.writeExtracted = async (...a) => { order.push("write"); return realWrite(...a); };
  const files = new Map<string, ArrayBuffer>();
  const enqueued: Job[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const confirms: string[] = [];
  const processed: Record<string, { path: string; date: string }> = {};
  const marked: string[] = [];
  const renames: [string, string][] = [];
  const settings = { ...baseSettings, ...over };
  const extract = vi.fn(async (..._a: any[]): Promise<PdfExtraction> => ({ summary: "sum", notes: [note("Anatomy", "N", ["a"], "1")] }));
  const confirmAnswer = { value: true as boolean | Promise<boolean> };
  const readCalls = { active: 0, max: 0, total: 0 };
  const client = { v: { extractPdf: extract } as any };
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
    settings: () => settings, today: () => "2026-10-09",
    enqueue: (j) => { enqueued.push(j); return true; },
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
  return { flow, vault, files, enqueued, infos, errors, confirms, processed, marked, order, renames, extract, settings, confirmAnswer, readCalls, client, writer, slow };
}

/** Puts a PDF into the vault (listed as a sibling) and makes its bytes readable. */
const drop = (c: Ctx, path: string, bytes: ArrayBuffer) => { c.files.set(path, bytes); c.vault.files.set(path, "%PDF"); };
const noSignal = { cancelled: false };
const noCp = async () => {};
const job = (path: string): Job => ({ id: `pdf:${path}`, kind: "pdf", path });

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
    expect(c.enqueued).toEqual([job("Topic/paper.pdf")]);
    expect([...c.errors, ...c.infos, ...c.confirms]).toEqual([]);
  });

  test("accepts paper.pdf+ too", async () => {
    const c = setup();
    drop(c, "Topic/paper.pdf+", pdf1);
    await c.flow.onFileEvent("Topic/paper.pdf+");
    expect(c.renames).toEqual([["Topic/paper.pdf+", "Topic/paper.pdf"]]);
    expect(c.enqueued).toEqual([job("Topic/paper.pdf")]);
  });

  test("a pdf at the vault root and outside any research root is still triggered", async () => {
    const c = setup();
    drop(c, "paper+.PDF", pdf1);
    await c.flow.onFileEvent("paper+.PDF");
    expect(c.renames).toEqual([["paper+.PDF", "paper.PDF"]]);
    expect(c.enqueued).toEqual([job("paper.PDF")]);
  });

  test("stripSuffix off: no rename, job for the original path", async () => {
    const c = setup({ stripSuffix: false });
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([]);
    expect(c.enqueued).toEqual([job("Topic/paper+.pdf")]);
  });

  test("rename collision -> 'paper (2).pdf'", async () => {
    const c = setup();
    drop(c, "Topic/Paper.pdf", pdf3);
    drop(c, "Topic/paper+.pdf", pdf1);
    await c.flow.onFileEvent("Topic/paper+.pdf");
    expect(c.renames).toEqual([["Topic/paper+.pdf", "Topic/paper (2).pdf"]]);
    expect(c.enqueued).toEqual([job("Topic/paper (2).pdf")]);
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
    expect(c.enqueued).toEqual([job("Topic/paper.pdf")]);
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
    expect(c.enqueued).toEqual([job("Topic/locked.pdf")]);
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
    c.extract.mockImplementation(async (_t: string, _s: string[], _b: string, off: number) => ({
      summary: `sum${off}`, notes: [note("Anatomy", `Note ${off}`, [`k${off}`], `${off + 1}-${off + 50}`)],
    }));
    await c.flow.run(job("Topic/big.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 50, 100]);
    expect(c.extract.mock.calls[0][0]).toBe("Topic");
    expect(c.extract.mock.calls[0][1]).toEqual(["Anatomy"]);
    expect(c.infos).toEqual(["Extracted 3 notes from big.pdf"]);
    const summary = c.vault.files.get("Topic/Sources/big - Summary.md")!;
    expect(summary).toContain("sum0 sum50 sum100");
    expect(c.vault.files.has("Topic/Anatomy/Note 0.md")).toBe(true);
    expect(c.vault.files.has("Topic/Anatomy/Note 100.md")).toBe(true);
  });

  test("subfolder list excludes From PDFs and Sources", async () => {
    const c = setup();
    c.vault.folders.add("Topic/From PDFs"); c.vault.folders.add("Topic/Sources");
    c.files.set("Topic/a.pdf", pdf1);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls[0][1]).toEqual(["Anatomy"]);
  });

  test("same-titled notes from different chunks are merged", async () => {
    const c = setup();
    c.files.set("Topic/big.pdf", pdf120);
    const pts = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const results: PdfExtraction[] = [
      { summary: "S", notes: [note("Anatomy", "Horizon", [...pts("a", 6), "dup"], "3-5", "first")] },
      { summary: "S", notes: [note("anatomy", "horizon", ["dup", ...pts("b", 6)], "60-62, 3-5", "second")] },
      { summary: "S", notes: [] },
    ];
    let i = 0;
    c.extract.mockImplementation(async () => results[i++]);
    await c.flow.run(job("Topic/big.pdf"), noSignal, noCp);
    expect(c.infos).toEqual(["Extracted 1 notes from big.pdf"]);
    const text = c.vault.files.get("Topic/Anatomy/Horizon.md")!;
    expect(text).toContain("first");
    expect(text).not.toContain("second");
    expect(text).toContain("a0");
    expect(text).toContain("3-5, 60-62");
    expect(text).not.toContain("b3"); // capped at 10: a0-a5, dup, b0-b2
    expect(text).toContain("b2");
    expect(text.match(/dup/g)!.length).toBe(1);
    const sum = c.vault.files.get("Topic/Sources/big - Summary.md")!;
    expect(sum).toContain("S");
    expect(sum).not.toContain("S S");
  });

  test("writes via writeExtracted then marks processed", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.order).toEqual(["write", "mark"]);
    expect(c.marked).toEqual([await sha256(pdf1)]);
    expect(c.infos).toEqual(["Extracted 1 notes from a.pdf"]);
  });

  test("already processed hash → silently returns without calling client", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "x", date: "d" };
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract).not.toHaveBeenCalled();
    expect(c.infos).toEqual([]);
  });

  test("concurrent runs of identical content process only once", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1); c.files.set("Topic/b.pdf", pdf1);
    await Promise.all([c.flow.run(job("Topic/a.pdf"), noSignal, noCp), c.flow.run(job("Topic/b.pdf"), noSignal, noCp)]);
    expect(c.extract).toHaveBeenCalledTimes(1);
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
    expect(c.extract).not.toHaveBeenCalled();
  });

  test("encrypted pdf → notice naming file, job completes without throwing", async () => {
    const c = setup();
    c.files.set("Topic/secret.pdf", encrypted);
    await expect(c.flow.run(job("Topic/secret.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.errors[0]).toContain("secret.pdf");
    expect(c.extract).not.toHaveBeenCalled();
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
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 2]);
    expect(c.marked.length).toBe(1);
  });

  test("pdf deleted before its job runs → silently skipped", async () => {
    const c = setup();
    await expect(c.flow.run(job("Topic/gone.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.errors).toEqual([]);
    expect(c.infos).toEqual([]);
    expect(c.extract).not.toHaveBeenCalled();
  });

  test("retryable ApiError propagates and marks nothing", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.extract.mockRejectedValue(new ApiError("overloaded", 529));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(c.marked).toEqual([]);
    // inFlight must be cleared so the retry can run
    c.extract.mockResolvedValue({ summary: "s", notes: [] });
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract).toHaveBeenCalledTimes(2);
  });

  test("a network TypeError from extractPdf propagates (retryable)", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.extract.mockRejectedValue(new TypeError("offline"));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(TypeError);
    expect(c.marked).toEqual([]);
    expect(c.errors).toEqual([]);
  });

  test("non-retryable error → notice, nothing processed, no throw", async () => {
    const c = setup();
    c.files.set("Topic/a.pdf", pdf1);
    c.extract.mockRejectedValue(new ApiError("bad request", 400));
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
    c.extract.mockImplementation(async () => { sig.cancelled = true; return { summary: "s", notes: [note("Anatomy", "N", ["a"], "1")] }; });
    await c.flow.run(job("Topic/big.pdf"), sig, noCp);
    expect(c.extract).toHaveBeenCalledTimes(1);
    expect(c.order).toEqual([]);
    expect(c.marked).toEqual([]);
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
    c.extract.mockImplementation(async (...a: any[]): Promise<PdfExtraction> => {
      const off = a[3] as number;
      if (off === failAt && !failed) { failed = true; throw err(); }
      return { summary: "sum", notes: [note("Anatomy", `N${off}`, [`k${off}`], String(off + 1))] };
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
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1, 1, 2]);
    expect(c.marked.length).toBe(1);
    for (const t of ["N0", "N1", "N2"]) expect(c.vault.files.has(`Topic/Anatomy/${t}.md`)).toBe(true);
  });

  test("cache is cleared after success: re-running the same bytes re-extracts every chunk", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("overloaded", 503));
    const q = queueFor(c);
    q.add(job("Topic/a.pdf"));
    await q.idle();
    c.extract.mockClear();
    delete c.processed[await sha256(pdf3)];
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("cache is cleared on non-retryable failure", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("bad request", 400));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).resolves.toBeUndefined();
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1]);
    c.extract.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("cache is cleared on cancellation", async () => {
    const c = chunkSetup();
    const sig = { cancelled: false };
    c.extract.mockImplementation(async (...a: any[]) => {
      if (a[3] === 1) sig.cancelled = true;
      return { summary: "s", notes: [note("Anatomy", `N${a[3]}`, ["k"], "1")] };
    });
    await c.flow.run(job("Topic/a.pdf"), sig, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1]);
    c.extract.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
  });

  test("dropCache(path) forgets chunks of a job the queue gave up on", async () => {
    const c = chunkSetup();
    impl(c, 1, () => new ApiError("overloaded", 503));
    await expect(c.flow.run(job("Topic/a.pdf"), noSignal, noCp)).rejects.toBeInstanceOf(ApiError);
    c.flow.dropCache("Topic/a.pdf");
    c.extract.mockClear();
    impl(c, -1, () => new Error("x"));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(c.extract.mock.calls.map((x) => x[3])).toEqual([0, 1, 2]);
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

  test("3-chunk pdf emits 'Preparing…', chunk 1/3, 2/3, 3/3 steps then done with folder and note counts", async () => {
    const { c, events, kinds } = withSink();
    c.settings.pdfPagesPerChunk = 1;
    c.files.set("Topic/a.pdf", pdf3);
    c.extract.mockImplementation(async (...a: any[]) => ({ summary: "s", notes: [note("Anatomy", `N${a[3]}`, ["k"], String(a[3] + 1))] }));
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(kinds()).toEqual([
      { kind: "step", text: "Preparing a.pdf…" },
      { kind: "step", text: "Analysing a.pdf (chunk 1/3)…" },
      { kind: "step", text: "Analysing a.pdf (chunk 2/3)…" },
      { kind: "step", text: "Analysing a.pdf (chunk 3/3)…" },
      { kind: "done", folders: 1, notes: 3 },
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
      { kind: "failed", error: "the PDF is encrypted." },
    ]);
    expect(e1.c.errors).toEqual([]); // with a sink the hub shows the notice

    const e2 = withSink();
    e2.c.settings.pdfPagesPerChunk = 1;
    e2.c.files.set("Topic/a.pdf", pdf3);
    const sig = { cancelled: false };
    e2.c.extract.mockImplementation(async () => { sig.cancelled = true; return { summary: "s", notes: [] }; });
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

    const b = withSink();
    b.c.files.set("Other/a.pdf", pdf1);
    await b.c.flow.run(job("Other/a.pdf"), noSignal, noCp);
    expect(b.kinds()).toEqual([
      { kind: "step", text: "Preparing a.pdf…" },
      { kind: "failed", error: "it is not inside a researched folder" },
    ]);

    const d = withSink();
    d.c.files.set("Topic/a.pdf", pdf1);
    d.c.extract.mockRejectedValue(new ApiError("bad request", 400));
    await d.c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(d.kinds().at(-1)).toEqual({ kind: "failed", error: "bad request" });
  });

  test("already processed pdf emits nothing", async () => {
    const { c, events } = withSink();
    c.files.set("Topic/a.pdf", pdf1);
    c.processed[await sha256(pdf1)] = { path: "x", date: "d" };
    await c.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(events).toEqual([]);
  });

  test("retryable chunk error emits the retry step and rethrows", async () => {
    const { c, kinds } = withSink();
    c.files.set("Topic/a.pdf", pdf1);
    c.extract.mockRejectedValue(new ApiError("overloaded", 529));
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
    c.extract.mockImplementation(async () => { sig.cancelled = true; throw new ApiError("overloaded", 503); });
    await expect(c.flow.run(job("Topic/a.pdf"), sig, noCp)).rejects.toBeInstanceOf(ApiError);
    expect(events.some((x) => x[1].kind === "step" && x[1].text.startsWith("Retrying"))).toBe(false);
    const first = events[0][2].runId;
    c.extract.mockReset();
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
    expect(c.extract).not.toHaveBeenCalled();
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
    expect(b.events.at(-1)).toEqual({ kind: "failed", error: "the PDF is encrypted." });
    expect([...b.c.errors, ...b.c.infos]).toEqual([]);
    // non-retryable chunk error
    const d = withSink(); d.c.files.set("Topic/a.pdf", pdf1); d.c.extract.mockRejectedValue(new ApiError("bad request", 400));
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
    expect(nb.errors).toEqual(["Could not analyse s.pdf: the PDF is encrypted."]);
    const nd = setup(); nd.files.set("Topic/a.pdf", pdf1); nd.extract.mockRejectedValue(new ApiError("bad request", 400));
    await nd.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(nd.errors).toEqual(["Could not analyse a.pdf: bad request"]);
    const ne = setup(); ne.files.set("Topic/a.pdf", pdf1);
    await ne.flow.run(job("Topic/a.pdf"), noSignal, noCp);
    expect(ne.infos).toEqual(["Extracted 1 notes from a.pdf"]);
  });
});

describe("fix round 1: pdf failure notices carry one prefix", () => {
  test("hub-level: an encrypted PDF gives exactly 'Could not analyse s.pdf: the PDF is encrypted.'; a missing key and an API error read cleanly too", async () => {
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
    const c = setup(); (c.flow as any).deps.progress = hub.sink; c.files.set("Topic/e.pdf", pdf1); c.extract.mockRejectedValue(new ApiError("bad request", 400));
    await c.flow.run(job("Topic/e.pdf"), noSignal, noCp);
    expect(notices).toEqual([
      "Could not analyse s.pdf: the PDF is encrypted.",
      "Could not analyse k.pdf: no Claude API key — add it in the plugin settings",
      "Could not analyse e.pdf: bad request",
    ]);
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
  });
});
