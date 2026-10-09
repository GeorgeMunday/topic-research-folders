import { describe, expect, test } from "vitest";
import { SUBJECTS, parseExtras, resolveSubject, normaliseLanguage, isSubject } from "../src/subjects";
import { renderNote, renderOverview } from "../src/vault/noteTemplate";
import { parseNotes, parseOutline } from "../src/research/parse";
import { outlinePrompt, notesPrompt } from "../src/research/prompts";
import type { NoteContent } from "../src/types";

const base: NoteContent = { title: "Moves", summary: "S.", keyPoints: ["k"], plainWords: "Plain." };
const ctx = { topic: "Rust", subtopic: "Ownership", date: "2026-10-09" };

const RAW = {
  coding: { examples: ["// A move transfers ownership\nlet a = String::from(\"x\");\nlet b = a;\nprintln!(\"{}\", b);"], mistakes: ["Using a after it was moved", "Forgetting to clone"] },
  maths: { formulas: ["a^2 + b^2 = c^2", "Area is $\\frac{1}{2}bh$"], workedExample: ["Take a 3-4 triangle", "Square both legs: 9 + 16", "Root of 25 is 5"] },
  science: { keyTerms: [{ term: "Mass", definition: "How much matter" }], realWorldExample: "A bowling ball is heavier than a tennis ball." },
  language: { vocabulary: [{ word: "gato", meaning: "cat", example: "El gato duerme." }, { word: "perro", meaning: "dog", example: "El perro | corre." }] },
  history: { timeline: [{ date: "1939", event: "War begins" }, { date: "1945", event: "War ends" }], keyPeople: [{ name: "Churchill", role: "UK prime minister" }] },
  general: { example: "A cup of tea going cold." },
} as const;

const heading = (md: string, h: string) => md.indexOf(`\n## ${h}\n`);

describe("SUBJECTS table", () => {
  test("has exactly the six subjects and each entry carries prompt text, JSON shape, parser and renderer", () => {
    expect(Object.keys(SUBJECTS).sort()).toEqual(["coding", "general", "history", "language", "maths", "science"]);
    for (const def of Object.values(SUBJECTS)) {
      expect(typeof def.instructions("rust")).toBe("string");
      expect(def.shape("rust")).toContain("{");
      expect(typeof def.parse).toBe("function");
      expect(typeof def.render).toBe("function");
    }
    expect(isSubject("coding")).toBe(true);
    expect(isSubject("cooking")).toBe(false);
  });

  test("each subject renders its section between 'In plain words' and 'My notes'", () => {
    const expected: Record<string, string[]> = {
      coding: ["Code examples", "Common mistakes"], maths: ["Formulas", "Worked example"], science: ["Key terms", "Real-world example"],
      language: ["Vocabulary"], history: ["Timeline", "Key people"], general: ["Example"],
    };
    for (const [subject, headings] of Object.entries(expected)) {
      const extras = parseExtras(subject, RAW[subject as keyof typeof RAW], "rust");
      expect(extras, subject).toBeDefined();
      const md = renderNote({ ...base, extras }, ctx);
      const from = heading(md, "In plain words"), to = heading(md, "My notes");
      let last = from;
      for (const h of headings) {
        const at = heading(md, h);
        expect(at, `${subject}: ${h}`).toBeGreaterThan(last);
        expect(at).toBeLessThan(to);
        last = at;
      }
    }
  });

  test("a note without extras renders exactly the base sections", () => {
    const md = renderNote(base, ctx);
    expect(md).toContain("## In plain words\nPlain.\n\n## My notes");
  });
});

describe("coding", () => {
  const md = renderNote({ ...base, extras: parseExtras("coding", RAW.coding, "rust") }, ctx);
  test("code blocks carry the language tag and the common mistakes are bullets", () => {
    expect(md).toContain("## Code examples\n\n```rust\n// A move transfers ownership\nlet a = String::from(\"x\");");
    expect(md).toContain("## Common mistakes\n- Using a after it was moved\n- Forgetting to clone");
  });
  test("at most 3 examples and 4 mistakes; a block over 25 lines is dropped; no valid example means invalid", () => {
    const long = Array.from({ length: 26 }, (_, i) => `// line ${i}`).join("\n");
    const ok = (n: number) => `// ex ${n}\nlet x = ${n};`;
    const e = parseExtras("coding", { examples: [long, ok(1), ok(2), ok(3), ok(4)], mistakes: ["a", "b", "c", "d", "e"] }, "rust")!;
    expect(e.examples).toEqual([ok(1), ok(2), ok(3)]);
    expect(e.mistakes).toEqual(["a", "b", "c", "d"]);
    expect(parseExtras("coding", { examples: [long], mistakes: ["x"] }, "rust")).toBeUndefined();
  });
  test("fences the model added are stripped, and a code body containing ``` gets a longer fence", () => {
    const e = parseExtras("coding", { examples: ["```rust\nlet a = 1;\n```"], mistakes: [] }, "rust")!;
    expect(e.examples).toEqual(["let a = 1;"]);
    const tricky = renderNote({ ...base, extras: parseExtras("coding", { examples: ["let s = \"```\";"], mistakes: [] }, "rust") }, ctx);
    expect(tricky).toContain("````rust\nlet s = \"```\";\n````");
  });
  test("a coding note without a language still renders an untagged block", () => {
    const m = renderNote({ ...base, extras: parseExtras("coding", RAW.coding) }, ctx);
    expect(m).toContain("## Code examples\n\n```\n// A move");
  });
});

describe("maths, science, language, history", () => {
  test("maths: LaTeX formulas in $$ unless they already use $, then numbered steps", () => {
    const md = renderNote({ ...base, extras: parseExtras("maths", RAW.maths) }, ctx);
    expect(md).toContain("## Formulas\n\n$$a^2 + b^2 = c^2$$\n\nArea is $\\frac{1}{2}bh$\n");
    expect(md).toContain("## Worked example\n1. Take a 3-4 triangle\n2. Square both legs: 9 + 16\n3. Root of 25 is 5");
  });
  test("science: key terms then a real-world example", () => {
    const md = renderNote({ ...base, extras: parseExtras("science", RAW.science) }, ctx);
    expect(md).toContain("## Key terms\n- **Mass**: How much matter");
    expect(md).toContain("## Real-world example\nA bowling ball is heavier than a tennis ball.");
  });
  test("language: a vocabulary table, 10 rows at most, pipes escaped", () => {
    const md = renderNote({ ...base, extras: parseExtras("language", RAW.language) }, ctx);
    expect(md).toContain("## Vocabulary\n\n| Word | Meaning | Example sentence |\n| --- | --- | --- |\n| gato | cat | El gato duerme. |\n| perro | dog | El perro \\| corre. |");
    const many = { vocabulary: Array.from({ length: 14 }, (_, i) => ({ word: `w${i}`, meaning: "m", example: "e" })) };
    expect((parseExtras("language", many)!.vocabulary as unknown[]).length).toBe(10);
  });
  test("history: timeline in the given order, then key people", () => {
    const md = renderNote({ ...base, extras: parseExtras("history", RAW.history) }, ctx);
    expect(md).toContain("## Timeline\n- **1939**: War begins\n- **1945**: War ends");
    expect(md).toContain("## Key people\n- **Churchill**: UK prime minister");
  });
});

describe("invalid or missing extras never crash", () => {
  test("garbage falls back: general when an example is usable, otherwise no extras", () => {
    for (const bad of [undefined, null, "text", 5, [], {}, { formulas: "nope" }, { examples: [{}] }]) {
      expect(() => parseExtras("maths", bad)).not.toThrow();
      expect(parseExtras("maths", bad)).toBeUndefined();
    }
    expect(parseExtras("maths", { example: "Fall back here." })).toMatchObject({ subject: "general", example: "Fall back here." });
    expect(parseExtras("not-a-subject", RAW.general)).toMatchObject({ subject: "general" });
    const md = renderNote({ ...base, extras: parseExtras("maths", "garbage") }, ctx);
    expect(md).not.toContain("## Formulas");
  });

  test("parseNotes keeps a note whose extras are broken; the batch survives", () => {
    const json = JSON.stringify({ notes: [
      { title: "A", summary: "s", keyPoints: ["k"], plainWords: "p", extras: "oops" },
      { title: "B", summary: "s", keyPoints: ["k"], plainWords: "p", extras: RAW.maths },
      { title: "C", summary: "s", keyPoints: ["k"], plainWords: "p" },
    ] });
    const notes = parseNotes(json, 5, "maths").notes;
    expect(notes.map((n) => n.title)).toEqual(["A", "B", "C"]);
    expect(notes[0].extras).toBeUndefined();
    expect(notes[1].extras).toMatchObject({ subject: "maths" });
    expect(notes[2].extras).toBeUndefined();
  });

  test("parseNotes without a subject asks for general extras and tags coding notes with the language", () => {
    const g = parseNotes(JSON.stringify({ notes: [{ title: "A", summary: "s", keyPoints: ["k"], plainWords: "p", extras: RAW.general }] }), 3).notes;
    expect(g[0].extras).toMatchObject({ subject: "general" });
    const c = parseNotes(JSON.stringify({ notes: [{ title: "A", summary: "s", keyPoints: ["k"], plainWords: "p", extras: RAW.coding }] }), 3, "coding", "rust").notes;
    expect(c[0].extras).toMatchObject({ subject: "coding", codeLanguage: "rust" });
  });
});

describe("subject, language and inheritance", () => {
  test("normaliseLanguage keeps common language names and drops junk", () => {
    expect(normaliseLanguage(" Rust ")).toBe("rust");
    expect(normaliseLanguage("C++")).toBe("cpp");
    expect(normaliseLanguage("C#")).toBe("csharp");
    expect(normaliseLanguage("py thon!")).toBe("python");
    expect(normaliseLanguage("")).toBeUndefined();
    expect(normaliseLanguage(3)).toBeUndefined();
  });

  test("resolveSubject: own wins, a missing language is inherited from a coding parent, nothing known is general", () => {
    const rust = { subject: "coding" as const, codeLanguage: "rust" };
    expect(resolveSubject(undefined, rust)).toEqual(rust);
    expect(resolveSubject({ subject: "coding" }, rust)).toEqual(rust);
    expect(resolveSubject({ subject: "maths" }, rust)).toEqual({ subject: "maths" });
    expect(resolveSubject({ subject: "coding", codeLanguage: "go" }, rust)).toEqual({ subject: "coding", codeLanguage: "go" });
    expect(resolveSubject(undefined, undefined)).toEqual({ subject: "general" });
  });

  test("parseOutline reads subject and codeLanguage; unknown subject is ignored; the language is only kept for coding", () => {
    const o = (extra: object) => parseOutline(JSON.stringify({ topic: "T", summary: "s", subfolders: [{ name: "A", why: "w" }], ...extra }), 5);
    expect(o({ subject: "coding", codeLanguage: "Rust" })).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    expect(o({ subject: "maths", codeLanguage: "rust" }).codeLanguage).toBeUndefined();
    expect(o({ subject: "cooking" }).subject).toBeUndefined();
    expect(o({}).subject).toBeUndefined();
  });
});

describe("prompts", () => {
  test("the outline prompt asks for subject and codeLanguage and lists every subject", () => {
    const p = outlinePrompt("Ownership", ["Rust"], 5);
    expect(p).toContain('"subject"');
    expect(p).toContain('"codeLanguage"');
    for (const id of Object.keys(SUBJECTS)) expect(p).toContain(id);
    expect(p).toMatch(/Ownership.*Rust.*coding/s);
  });

  test("the notes prompt carries the subject's instructions and JSON shape; coding names the language", () => {
    const c = notesPrompt("Ownership", [], { name: "Moves", why: "w" }, 2, { subject: "coding", codeLanguage: "rust" });
    expect(c).toContain("Code examples");
    expect(c).toContain("25 lines");
    expect(c).toContain("rust");
    expect(c).toContain('"extras"');
    const m = notesPrompt("Triangles", [], { name: "Pythagoras", why: "w" }, 2, { subject: "maths" });
    expect(m).toContain("LaTeX");
    expect(m).toMatch(/double/i);
    expect(m).not.toContain("Code examples");
    expect(notesPrompt("T", [], { name: "S", why: "w" }, 2)).toContain("## Example");
  });
});

describe("overview frontmatter", () => {
  test("the Overview records subject and codeLanguage; none when unknown", () => {
    const md = renderOverview({ topic: "Rust", summary: "S", subfolders: [], subject: "coding", codeLanguage: "rust" }, [], "2026-10-09");
    expect(md).toContain("research-root: true\nsubject: coding\ncodeLanguage: rust\ntags: [research]");
    expect(renderOverview({ topic: "Rust", summary: "S", subfolders: [] }, [], "2026-10-09")).not.toContain("subject:");
    expect(renderOverview({ topic: "Maths", summary: "S", subfolders: [], subject: "maths" }, [], "2026-10-09")).not.toContain("codeLanguage");
  });
});
