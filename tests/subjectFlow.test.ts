import { beforeAll, describe, expect, test, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { ResearchFlow } from "../src/flows/researchFlow";
import { KeypointFlow } from "../src/flows/keypointFlow";
import { PdfFlow } from "../src/flows/pdfFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { Job, KeyPoint, Outline, PdfOverview, Progress } from "../src/types";
import type { Settings } from "../src/settings";

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
const noSignal = { cancelled: false };
const noCp = async () => {};
const root = (subject: string, lang?: string) =>
  `---\ntopic: "x"\nresearch-root: true\nsubject: ${subject}\n${lang ? `codeLanguage: ${lang}\n` : ""}tags: [research]\n---\n\n> A topic.\n`;

function vaultWithRust(subject = "coding", lang: string | undefined = "rust") {
  const v = new MemVault();
  for (const f of ["Programming", "Programming/Rust", "Programming/Rust/Ownership"]) v.folders.add(f);
  v.files.set("Programming/Rust/Rust - Overview.md", root(subject, lang));
  return v;
}

function researchFlow(v: MemVault, outline: (...a: any[]) => Promise<Outline>, notes = vi.fn(async (..._a: any[]) => ({ notes: [note("n")], quiz: { questions: [], answers: [] } }))) {
  const events: Progress[] = [];
  const flow = new ResearchFlow({
    client: () => ({ outline, notes } as any), writer: new VaultWriter(v), notify, rename: async () => {},
    settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    progress: (_p, e) => { events.push(e); },
  });
  return { flow, notes, events };
}

describe("research flow subject", () => {
  const sub = [{ name: "Moves", why: "w" }];

  test("the outline's own subject reaches the review untouched; an outline without one stays without (the parent's applies when the job runs)", async () => {
    const own = researchFlow(vaultWithRust(), async (topic) => ({ topic, summary: "s", subfolders: sub, subject: "coding", codeLanguage: "rust" }));
    await own.flow.run({ id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], force: true }, noSignal, noCp);
    expect((own.events.find((e) => e.kind === "outline") as Extract<Progress, { kind: "outline" }>).outline).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    const none = researchFlow(vaultWithRust(), async (topic) => ({ topic, summary: "s", subfolders: sub }));
    await none.flow.run({ id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], force: true }, noSignal, noCp);
    expect((none.events.find((e) => e.kind === "outline") as Extract<Progress, { kind: "outline" }>).outline.subject).toBeUndefined();
  });

  test("the model's own subject wins when it clearly differs", async () => {
    const v = vaultWithRust();
    const { flow, events } = researchFlow(v, async (topic) => ({ topic, summary: "s", subfolders: sub, subject: "maths" }));
    await flow.run({ id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], force: true }, noSignal, noCp);
    const o = events.find((e) => e.kind === "outline") as Extract<Progress, { kind: "outline" }>;
    expect(o.outline.subject).toBe("maths");
    expect(o.outline.codeLanguage).toBeUndefined();
  });

  test("notes are requested for the job's subject and the Overview records it", async () => {
    const v = vaultWithRust();
    const { flow, notes } = researchFlow(v, async (topic) => ({ topic, summary: "s", subfolders: sub }));
    await flow.run({ id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], approved: sub, subject: "coding", codeLanguage: "rust" }, noSignal, noCp);
    expect((notes.mock.calls[0] as any[])[4]).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    const md = v.files.get("Programming/Rust/Ownership/Ownership - Overview.md")!;
    expect(md).toContain("subject: coding\ncodeLanguage: rust");
  });

  test("a job without a subject (an old saved review) inherits the root's", async () => {
    const v = vaultWithRust("history", undefined);
    const { flow, notes } = researchFlow(v, async (topic) => ({ topic, summary: "s", subfolders: sub }));
    await flow.run({ id: "r", kind: "research", path: "Programming/Rust/Ownership", done: [], approved: sub }, noSignal, noCp);
    expect((notes.mock.calls[0] as any[])[4]).toMatchObject({ subject: "history" });
  });
});

describe("key point flow subject", () => {
  const job = (over: object = {}) => ({ id: "k", kind: "keypoint", path: "Programming/Rust/Ownership/Moves/Moves.md", folder: "Programming/Rust/Ownership/Moves", pdfName: "p.pdf", topic: "p", parents: [], point: kp("Moves"), ...over }) as Job;
  const run = async (v: MemVault, j: Job) => {
    v.folders.add("Programming/Rust/Ownership/Moves");
    const notes = vi.fn(async (..._a: any[]) => ({ notes: [note("n")], quiz: { questions: [], answers: [] } }));
    await new KeypointFlow({ client: () => ({ notes } as any), writer: new VaultWriter(v), notify, settings: () => settings, today: () => "2026-10-09" }).run(j, noSignal, noCp);
    return (notes.mock.calls[0] as any[])[4];
  };

  test("reads the nearest root's Overview at run time, so a user's edit wins", async () => {
    expect(await run(vaultWithRust(), job())).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    expect(await run(vaultWithRust("maths", undefined), job())).toMatchObject({ subject: "maths" });
  });

  test("the job's own subject (a PDF that differs from its root) takes precedence; nothing known is general", async () => {
    expect(await run(vaultWithRust(), job({ subject: "history" }))).toMatchObject({ subject: "history" });
    const bare = new MemVault();
    expect(await run(bare, job({ folder: "Free/Moves", path: "Free/Moves/Moves.md" }))).toMatchObject({ subject: "general" });
  });
});

describe("pdf flow subject", () => {
  let pdf: ArrayBuffer;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText("hello");
    const u = await doc.save();
    pdf = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
  });

  function make(v: MemVault, overview: PdfOverview) {
    const enqueued: Job[] = [];
    const flow = new PdfFlow({
      client: () => ({ overviewPdf: async () => overview, mergeOverviews: async () => overview } as any), writer: new VaultWriter(v), notify,
      confirm: { confirm: async () => true }, readBinary: async () => pdf, settings: () => settings, today: () => "2026-10-09",
      enqueue: (j) => { enqueued.push(j); return true; }, processed: () => ({}), markProcessed: async () => {}, rename: async () => {},
    });
    return { flow, enqueued };
  }
  const ov = (extra: object = {}): PdfOverview => ({ summary: "s", plainWords: "p", keyPoints: [kp("Moves")], ...extra });
  const pdfJob = (path: string): Job => ({ id: "p", kind: "pdf", path });

  test("a PDF outside any root records its subject in the new Overview; its key point jobs read it from there", async () => {
    const v = new MemVault();
    v.folders.add("Inbox");
    const { flow, enqueued } = make(v, ov({ subject: "science" }));
    await flow.run(pdfJob("Inbox/paper.pdf"), noSignal, noCp);
    expect(v.files.get("Inbox/paper/paper - Overview.md")).toContain("research-root: true\nsubject: science\n");
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as any).subject).toBeUndefined();
  });

  test("a PDF inside a root inherits it: the job carries a subject only when the PDF clearly differs", async () => {
    const same = make(vaultWithRust(), ov({ subject: "coding", codeLanguage: "rust" }));
    await same.flow.run(pdfJob("Programming/Rust/paper.pdf"), noSignal, noCp);
    expect((same.enqueued[0] as any).subject).toBeUndefined();

    const none = make(vaultWithRust(), ov());
    await none.flow.run(pdfJob("Programming/Rust/paper.pdf"), noSignal, noCp);
    expect((none.enqueued[0] as any).subject).toBeUndefined();

    const differs = make(vaultWithRust(), ov({ subject: "history" }));
    await differs.flow.run(pdfJob("Programming/Rust/paper.pdf"), noSignal, noCp);
    expect(differs.enqueued[0]).toMatchObject({ subject: "history" });
  });
});
