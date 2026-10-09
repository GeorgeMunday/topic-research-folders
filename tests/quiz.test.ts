import { describe, expect, test } from "vitest";
import { renderQuestions, renderAnswers, quizFileNames } from "../src/quiz";
import { parseNotes } from "../src/research/parse";
import { notesPrompt } from "../src/research/prompts";
import { renderNote, renderOverview, renderPdfOverview } from "../src/vault/noteTemplate";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { NoteContent, Quiz } from "../src/types";

const DATE = "2026-10-09";

describe("renderQuestions / renderAnswers", () => {
  test("the Questions file has numbered questions, no answers, My questions with a blank 1., and the Answers link last", () => {
    expect(renderQuestions({
      topic: "Black holes", subtopic: "Anatomy", date: DATE, file: "Anatomy - Questions", other: "Anatomy - Answers",
      questions: ["What is an event horizon?", "What does this print?\n```rust\nprintln!(\"{}\", 1);\n```"],
    })).toBe(
`---
topic: "Black holes"
subtopic: "Anatomy"
created: 2026-10-09
tags: [research, questions]
---

# Anatomy - Questions

1. What is an event horizon?
2. What does this print?
   \`\`\`rust
   println!("{}", 1);
   \`\`\`

## My questions

1.${" "}

Answers: [[Anatomy - Answers]]
`);
  });

  test("the Answers file is numbered like the questions, links each source note, has an empty My answers section and links back", () => {
    expect(renderAnswers({
      topic: "Black holes", subtopic: "Anatomy", date: DATE, file: "Anatomy - Answers", other: "Anatomy - Questions",
      answers: [{ text: "The point of no return.", link: "[[Black holes/Anatomy/Event horizon|Event horizon]]" }, { text: "It prints 1." }],
    })).toBe(
`---
topic: "Black holes"
subtopic: "Anatomy"
created: 2026-10-09
tags: [research, answers]
---

# Anatomy - Answers

1. The point of no return. (see [[Black holes/Anatomy/Event horizon|Event horizon]])
2. It prints 1.

## Answers to my questions

Questions: [[Anatomy - Questions]]
`);
  });

  test("an answer is one line even if the model broke it up; blank lines inside a question's code stay blank", () => {
    const a = renderAnswers({ topic: "T", subtopic: "S", date: DATE, file: "S - Answers", other: "S - Questions", answers: [{ text: "Line one\nline two" }] });
    expect(a).toContain("1. Line one line two\n");
    const q = renderQuestions({ topic: "T", subtopic: "S", date: DATE, file: "S - Questions", other: "S - Answers", questions: ["Fix:\n```\na\n\nb\n```"] });
    expect(q).toContain("1. Fix:\n   ```\n   a\n\n   b\n   ```\n");
  });

  test("file names carry the subfolder name; a suffix keeps the pair matched", () => {
    expect(quizFileNames("Anatomy")).toEqual({ questions: "Anatomy - Questions", answers: "Anatomy - Answers" });
    expect(quizFileNames("Anatomy", 2)).toEqual({ questions: "Anatomy - Questions (2)", answers: "Anatomy - Answers (2)" });
  });
});

const noteJson = (extra: object) => JSON.stringify({
  notes: [{ title: "Event horizon", summary: "s", keyPoints: ["k"], plainWords: "p" }], ...extra,
});

describe("parseNotes returns the quiz from the same response", () => {
  test("questions and answers line up; numbering the model added is stripped; the source note is kept", () => {
    const r = parseNotes(noteJson({
      questions: ["1. What is it?", "2) Why?"],
      answers: [{ answer: "A boundary.", note: "Event horizon" }, { answer: "Because." }],
    }), 3);
    expect(r.notes).toHaveLength(1);
    expect(r.quiz).toEqual({
      questions: ["What is it?", "Why?"],
      answers: [{ text: "A boundary.", note: "Event horizon" }, { text: "Because." }],
    });
  });

  test("more answers than questions: both are trimmed to the shorter", () => {
    const r = parseNotes(noteJson({ questions: ["a?", "b?"], answers: ["one", "two", "three"] }), 3);
    expect(r.quiz.questions).toEqual(["a?", "b?"]);
    expect(r.quiz.answers.map((a) => a.text)).toEqual(["one", "two"]);
  });

  test("more questions than answers: both are trimmed to the shorter", () => {
    const r = parseNotes(noteJson({ questions: ["a?", "b?", "c?"], answers: ["one"] }), 3);
    expect(r.quiz.questions).toEqual(["a?"]);
    expect(r.quiz.answers.map((a) => a.text)).toEqual(["one"]);
  });

  test("at most 8 pairs; blanks are ignored; a missing or malformed quiz is empty, never an error", () => {
    const many = Array.from({ length: 11 }, (_, i) => `q${i}?`);
    const r = parseNotes(noteJson({ questions: ["", ...many], answers: ["", ...many.map((_, i) => `a${i}`)] }), 3);
    expect(r.quiz.questions).toHaveLength(8);
    expect(r.quiz.answers).toHaveLength(8);
    expect(r.quiz.questions[0]).toBe("q0?");
    for (const bad of [{}, { questions: "x", answers: 3 }, { questions: ["a?"] }, { questions: [], answers: ["a"] }, { questions: [5, null], answers: [{}, []] }]) {
      expect(parseNotes(noteJson(bad), 3).quiz).toEqual({ questions: [], answers: [] });
    }
  });

  test("a coding question keeps its code block and line breaks", () => {
    const q = "What does this print?\n```rust\nprintln!(\"{}\", 1);\n```";
    expect(parseNotes(noteJson({ questions: [q], answers: ["1"] }), 3, "coding", "rust").quiz.questions).toEqual([q]);
  });
});

describe("the notes prompt asks for the quiz in the same call", () => {
  test("5 to 8 questions, answers matched by number with a source note; coding adds code questions", () => {
    const p = notesPrompt("T", [], { name: "S", why: "w" }, 3, { subject: "general" });
    expect(p).toContain('"questions"');
    expect(p).toContain('"answers"');
    expect(p).toMatch(/5 to 8/);
    expect(p).toMatch(/same order|numbered to match/i);
    expect(p).toMatch(/1 to 3 sentences/);
    expect(p).not.toMatch(/what does this code print/i);
    const c = notesPrompt("Ownership", [], { name: "Moves", why: "w" }, 3, { subject: "coding", codeLanguage: "rust" });
    expect(c).toMatch(/what does this code print/i);
    expect(c).toMatch(/fix this bug/i);
  });
});

describe("no template has a Questions & Answers section any more", () => {
  const note: NoteContent = { title: "T", summary: "s", keyPoints: ["k"], plainWords: "p" };
  test("topic note, subfolder Overview and PDF Overview keep My notes only", () => {
    const outputs = [
      renderNote(note, { topic: "T", subtopic: "S", date: DATE }),
      renderNote(note, { topic: "T", subtopic: "S", date: DATE, source: "p.pdf", pages: "1" }),
      renderOverview({ topic: "T", summary: "s", subfolders: [] }, [], DATE),
      renderPdfOverview({ pdfName: "p.pdf", overview: { summary: "s", plainWords: "p", keyPoints: [] }, links: [], asRoot: true }, DATE),
      renderPdfOverview({ pdfName: "p.pdf", overview: { summary: "s", plainWords: "p", keyPoints: [] }, links: [], asRoot: false }, DATE),
    ];
    for (const md of outputs) {
      expect(md).not.toContain("Questions & Answers");
      expect(md).not.toContain("**Q:**");
    }
    // The templates that have My notes still end with it; the subfolder Overview ends with its list.
    for (const md of outputs.filter((_, i) => i !== 2 && i !== 1)) expect(md.endsWith("## My notes\n\n- \n")).toBe(true);
    // A PDF-derived note ends with its Sources section (the PDF), after My notes.
    expect(outputs[1].endsWith("## My notes\n\n- \n\n## Sources\n\n- [[p.pdf]] (p. 1)\n")).toBe(true);
    expect(outputs[2].endsWith("## Study path\n\n")).toBe(true);
  });
});

// --- the writer ---
class Mem implements VaultLike {
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
const note = (title: string): NoteContent => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const quiz: Quiz = {
  questions: ["What is the horizon?", "Why does light stall?"],
  answers: [{ text: "The edge.", note: "Event horizon" }, { text: "Gravity.", note: "No such note" }],
};

describe("VaultWriter writes the Questions and Answers pair next to the notes", () => {
  test("writeSubfolder: '<Subfolder> - Questions.md' and '- Answers.md', answers link the real note files", async () => {
    const v = new Mem();
    v.folders.add("Black holes");
    const w = new VaultWriter(v);
    const r = await w.writeSubfolder("Black holes", "Black holes", { subfolder: "Anatomy", notes: [note("Event horizon"), note("Singularity")], quiz }, DATE);
    expect(r.noteTitles).toEqual(["Event horizon", "Singularity"]);
    const q = v.files.get("Black holes/Anatomy/Anatomy - Questions.md")!;
    const a = v.files.get("Black holes/Anatomy/Anatomy - Answers.md")!;
    expect(q).toContain("tags: [research, questions]");
    expect(q).toContain("1. What is the horizon?\n2. Why does light stall?");
    expect(q).toContain("Answers: [[Anatomy - Answers]]");
    expect(q).not.toContain("The edge.");
    expect(a).toContain("1. The edge. (see [[Black holes/Anatomy/Event horizon|Event horizon]])");
    expect(a).toContain("2. Gravity.\n");
    expect(a).toContain("Questions: [[Anatomy - Questions]]");
    expect(v.files.get("Black holes/Anatomy/Event horizon.md")).not.toContain("Questions & Answers");
  });

  test("the files use the folder's real name (collision-safe) and a second pair gets a matching suffix", async () => {
    const v = new Mem();
    v.folders.add("T");
    v.folders.add("T/Anatomy");
    const w = new VaultWriter(v);
    await w.writeSubfolder("T", "T", { subfolder: "Anatomy", notes: [note("A")], quiz }, DATE);
    expect(v.files.has("T/Anatomy (2)/Anatomy (2) - Questions.md")).toBe(true);
    expect(v.files.has("T/Anatomy (2)/Anatomy (2) - Answers.md")).toBe(true);
    // Notes landing in an existing folder twice: the pair is numbered together.
    await w.writeKeypointNotes("T/Anatomy (2)", "T", "Anatomy", [note("B")], DATE, { questions: ["Q?"], answers: [{ text: "A.", note: "B" }] });
    expect(v.files.has("T/Anatomy (2)/Anatomy (2) - Questions (2).md")).toBe(true);
    expect(v.files.get("T/Anatomy (2)/Anatomy (2) - Questions (2).md")).toContain("Answers: [[Anatomy (2) - Answers (2)]]");
    expect(v.files.get("T/Anatomy (2)/Anatomy (2) - Answers (2).md")).toContain("Questions: [[Anatomy (2) - Questions (2)]]");
    expect(v.files.get("T/Anatomy (2)/Anatomy (2) - Answers (2).md")).toContain("1. A. (see [[T/Anatomy (2)/B|B]])");
  });

  test("no questions means no quiz files (and the notes are still written)", async () => {
    const v = new Mem();
    v.folders.add("T");
    const w = new VaultWriter(v);
    await w.writeSubfolder("T", "T", { subfolder: "S", notes: [note("A")] }, DATE);
    await w.writeSubfolder("T", "T", { subfolder: "S2", notes: [note("A")], quiz: { questions: [], answers: [] } }, DATE);
    expect([...v.files.keys()].filter((f) => /Questions|Answers/.test(f))).toEqual([]);
    expect(v.files.has("T/S/A.md")).toBe(true);
  });
});
