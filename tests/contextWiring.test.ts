import { beforeAll, describe, expect, test, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ResearchFlow } from "../src/flows/researchFlow";
import { KeypointFlow } from "../src/flows/keypointFlow";
import { PdfFlow } from "../src/flows/pdfFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { Job, KeyPoint, Outline, PdfOverview } from "../src/types";
import type { Settings } from "../src/settings";
import { outlinePrompt, notesPrompt, pdfOverviewPrompt } from "../src/research/prompts";

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

const settings: Settings = {
  apiKey: "k", model: "m", modelChosen: false, useWebSearch: false, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 6, notesPerSubfolder: 2, maxDepth: 5, maxConcurrent: 1, maxRetries: 0,
  processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200,
};
const note = (title: string) => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const kp = (name: string): KeyPoint => ({ name, text: `${name} (p. 1)`, detail: "d", pages: "1" });
const notify = { info: () => {}, error: () => {} };
const ROOT = (summary: string) => `---\nresearch-root: true\n---\n\n# x\n\n> ${summary}\n`;

function vaultWithRust() {
  const v = new MemVault();
  for (const f of ["Programming", "Programming/Rust", "Programming/Rust/Ownership", "Programming/Rust/Borrowing", "Programming/Go"]) v.folders.add(f);
  v.files.set("Programming/Rust/Rust - Overview.md", ROOT("A systems language."));
  return v;
}

describe("prompts carry the context block", () => {
  const ctx = "Folder context: Path: University > Year 2";
  test("outline, notes and PDF overview prompts include it; an empty context adds nothing", () => {
    expect(outlinePrompt("T", [], 5, ctx)).toContain(ctx);
    expect(notesPrompt("T", [], { name: "S", why: "w" }, 2, { context: ctx })).toContain(ctx);
    expect(pdfOverviewPrompt("p", [], 0, ctx)).toContain(ctx);
    expect(outlinePrompt("T", [], 5)).toBe(outlinePrompt("T", [], 5, ""));
    expect(outlinePrompt("T", [], 5)).not.toContain("Folder context");
  });
});

describe("research flow", () => {
  test("outline and notes both get the context of the folders above the topic", async () => {
    const v = vaultWithRust();
    const outline = vi.fn(async (topic: string, _p: string[], _m: number, _c?: string): Promise<Outline> => ({ topic, summary: "s", subfolders: [{ name: "Moves", why: "w" }] }));
    const notes = vi.fn(async () => [note("n")]);
    const flow = new ResearchFlow({
      client: () => ({ outline, notes } as any), writer: new VaultWriter(v), notify, rename: async () => {},
      settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    });
    const job: Job = { id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], force: true };
    await flow.run(job, { cancelled: false }, async () => {});
    const ctx = outline.mock.calls[0][3]!;
    expect(ctx).toContain("Programming > Rust");
    expect(ctx).toContain("A systems language.");
    expect(ctx).toContain("Borrowing");
    expect(/Sibling folders.*/.exec(ctx)![0]).not.toContain("Ownership");
    expect(ctx).toContain("A systems language. Subfolders");
    await flow.run({ ...job, approved: [{ name: "Moves", why: "w" }] }, { cancelled: false }, async () => {});
    expect((notes.mock.calls[0] as any[])[4].context).toBe(ctx);
  });
});

describe("key point flow", () => {
  test("notes get the context of the key point's folder", async () => {
    const v = vaultWithRust();
    v.folders.add("Programming/Rust/Ownership/Moves");
    const notes = vi.fn(async () => [note("n")]);
    const flow = new KeypointFlow({ client: () => ({ notes } as any), writer: new VaultWriter(v), notify, settings: () => settings, today: () => "2026-10-09" });
    const job = { id: "k", kind: "keypoint", path: "Programming/Rust/Ownership/Moves/Moves.md", folder: "Programming/Rust/Ownership/Moves", pdfName: "p.pdf", topic: "p", parents: [], point: kp("Moves") } as Job;
    await flow.run(job, { cancelled: false }, async () => {});
    const ctx = (notes.mock.calls[0] as any[])[4].context as string;
    expect(ctx).toContain("Programming > Rust > Ownership");
    expect(ctx).toContain("A systems language.");
  });
});

describe("pdf flow", () => {
  let pdf: ArrayBuffer;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("hello");
    const u = await doc.save();
    pdf = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  });

  const overview: PdfOverview = { summary: "s", plainWords: "p", keyPoints: [kp("Moves")] };
  function make(v: MemVault) {
    const overviewPdf = vi.fn(async (..._a: any[]) => overview);
    const flow = new PdfFlow({
      client: () => ({ overviewPdf, mergeOverviews: async () => overview } as any), writer: new VaultWriter(v), notify,
      confirm: { confirm: async () => true }, readBinary: async () => pdf, settings: () => settings, today: () => "2026-10-09",
      enqueue: () => true, processed: () => ({}), markProcessed: async () => {}, rename: async () => {},
    });
    return { flow, overviewPdf };
  }

  test("a PDF inside a research root sees the root and its subfolders", async () => {
    const v = vaultWithRust();
    const { flow, overviewPdf } = make(v);
    await flow.run({ id: "p", kind: "pdf", path: "Programming/Rust/paper.pdf" }, { cancelled: false }, async () => {});
    const ctx = overviewPdf.mock.calls[0][4] as string;
    expect(ctx).toContain("Programming > Rust");
    expect(ctx).toContain("A systems language.");
    expect(ctx).toContain("Ownership");
  });

  test("a PDF outside any root sees the folders above it and its neighbours", async () => {
    const v = new MemVault();
    for (const f of ["Uni", "Uni/Year 2", "Uni/Year 2/Maths"]) v.folders.add(f);
    const { flow, overviewPdf } = make(v);
    await flow.run({ id: "p", kind: "pdf", path: "Uni/Year 2/paper.pdf" }, { cancelled: false }, async () => {});
    const ctx = overviewPdf.mock.calls[0][4] as string;
    expect(ctx).toContain("Uni > Year 2");
    expect(ctx).toContain("Maths");
  });
});
