import { describe, expect, test, vi } from "vitest";
import { ResearchFlow } from "../src/flows/researchFlow";
import { KeypointFlow } from "../src/flows/keypointFlow";
import { ClaudeClient, type HttpFn } from "../src/research/claudeClient";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { Job, KeyPoint } from "../src/types";
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
const notify = { info: () => {}, error: () => {} };
const noSignal = { cancelled: false };
const noCp = async () => {};
const note = (title: string) => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const quizFor = (title: string) => ({ questions: [`About ${title}?`, "Another?"], answers: [{ text: "Yes.", note: title }, { text: "No." }] });

describe("flows write the quiz of each subfolder from the same notes call", () => {
  test("research flow: one notes call per subfolder, and its Questions and Answers files appear beside the notes", async () => {
    const v = new MemVault();
    v.folders.add("Black holes");
    const notes = vi.fn(async (_t: string, _p: string[], s: { name: string }) => ({ notes: [note(`${s.name} idea`)], quiz: quizFor(`${s.name} idea`) }));
    const flow = new ResearchFlow({
      client: () => ({ notes, outline: async () => { throw new Error("unused"); } } as any), writer: new VaultWriter(v), notify,
      rename: async () => {}, settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    });
    const job: Job = { id: "r", kind: "research", path: "Black holes", done: [], approved: [{ name: "Anatomy", why: "w" }, { name: "History", why: "w" }] };
    await flow.run(job, noSignal, noCp);
    expect(notes).toHaveBeenCalledTimes(2);
    for (const s of ["Anatomy", "History"]) {
      expect(v.files.get(`Black holes/${s}/${s} - Questions.md`)).toContain(`1. About ${s} idea?`);
      expect(v.files.get(`Black holes/${s}/${s} - Answers.md`)).toContain(`1. Yes. (see [[Black holes/${s}/${s} idea|${s} idea]])`);
      expect(v.files.get(`Black holes/${s}/${s} idea.md`)).not.toContain("Questions & Answers");
    }
    // The subfolder Overview links the notes, not the quiz files.
    expect(v.files.get("Black holes/Black holes - Overview.md")).not.toMatch(/Questions|Answers/);
  });

  test("key point flow: the key point's folder gets the pair too", async () => {
    const v = new MemVault();
    v.folders.add("P");
    v.folders.add("P/Fusion");
    const kp: KeyPoint = { name: "Fusion", text: "Fusion (p. 1)", detail: "d", pages: "1" };
    const notes = vi.fn(async () => ({ notes: [note("Fusion basics")], quiz: quizFor("Fusion basics") }));
    const flow = new KeypointFlow({ client: () => ({ notes } as any), writer: new VaultWriter(v), notify, settings: () => settings, today: () => "2026-10-09" });
    await flow.run({ id: "k", kind: "keypoint", path: "P/Fusion/Fusion.md", folder: "P/Fusion", pdfName: "p.pdf", topic: "p", parents: [], point: kp } as Job, noSignal, noCp);
    expect(v.files.has("P/Fusion/Fusion - Questions.md")).toBe(true);
    expect(v.files.get("P/Fusion/Fusion - Answers.md")).toContain("[[P/Fusion/Fusion basics|Fusion basics]]");
  });
});

describe("one API request returns notes, extras and the quiz", () => {
  test("ClaudeClient.notes makes a single request and parses all three", async () => {
    const body = {
      notes: [{ title: "Moves", summary: "s", keyPoints: ["k"], plainWords: "p", extras: { examples: ["// move\nlet b = a;"], mistakes: ["m"] } }],
      questions: ["What does this print?\n```rust\nprintln!(\"{}\", 1);\n```"], answers: [{ answer: "1", note: "Moves" }],
    };
    const reqs: string[] = [];
    const http: HttpFn = async (req) => { reqs.push(req.body); return { status: 200, headers: {}, json: { content: [{ type: "text", text: JSON.stringify(body) }] } }; };
    const r = await new ClaudeClient(http, () => ({ apiKey: "k", model: "m", useWebSearch: false }))
      .notes("Ownership", ["Rust"], { name: "Moves", why: "w" }, 2, { subject: "coding", codeLanguage: "rust" });
    expect(reqs).toHaveLength(1);
    expect(r.notes[0].extras).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    expect(r.quiz.questions[0]).toContain("```rust");
    expect(r.quiz.answers).toEqual([{ text: "1", note: "Moves" }]);
    const prompt = JSON.parse(reqs[0]).messages[0].content as string;
    expect(prompt).toContain('"questions"');
    expect(prompt).toContain("Code examples");
  });
});
