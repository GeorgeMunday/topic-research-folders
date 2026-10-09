// Pure: the per-subject extra section of a note. One table entry per subject holds its prompt
// instructions, the JSON shape the model must return, a validating parser and a renderer, so
// adding a subject later is one more entry. No `obsidian` import.

/** `extras` of one note: validated model output plus the subject (and code language) it was made for. */
export interface Extras {
  subject: string;
  codeLanguage?: string;
  [field: string]: unknown;
}

export interface SubjectDef {
  /** Prompt text: what the model must add to every note. */
  instructions(codeLanguage?: string): string;
  /** JSON shape of the note's "extras" field. */
  shape(codeLanguage?: string): string;
  /** The fields of valid extras, or null when the raw value is unusable. */
  parse(raw: Record<string, unknown>, codeLanguage?: string): Record<string, unknown> | null;
  /** Extra quiz guidance for this subject (e.g. code questions); none by default. */
  quiz?(codeLanguage?: string): string;
  /** Markdown sections (separated by blank lines, none trailing) for validated extras. */
  render(extras: Extras): string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).flatMap((x) => (typeof x === "string" && x.trim() !== "" ? [x.trim()] : [])).slice(0, max);
const rows = (v: unknown, keys: string[], max: number, required: number): Record<string, string>[] =>
  (Array.isArray(v) ? v : []).flatMap((r) => {
    if (!isObj(r)) return [];
    const row = Object.fromEntries(keys.map((k) => [k, oneLine(str(r[k]))]));
    return keys.slice(0, required).every((k) => row[k] !== "") ? [row] : [];
  }).slice(0, max);

const LANGUAGE_ALIASES: Record<string, string> = { "c#": "csharp", "c++": "cpp", "f#": "fsharp", "c-sharp": "csharp" };

/** Lowercase language id such as `rust`, `cpp` or `csharp`; undefined when nothing usable is left. */
export function normaliseLanguage(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, "").slice(0, 20);
  // The id doubles as the code fence tag, and Obsidian highlights `csharp`, not `c#`.
  return s === "" ? undefined : LANGUAGE_ALIASES[s] ?? s;
}

const MAX_CODE_LINES = 25;
const stripFence = (code: string) => {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(code.trim());
  return (m ? m[1] : code).replace(/\s+$/, "");
};
// A fence longer than any backtick run inside the code, so the block cannot end early.
const fenceFor = (code: string) => "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((r) => r.length + 1)));
const listItem = (s: string, i: number) => `${i + 1}. ${oneLine(s).replace(/^\d+[.)]\s*/, "")}`;
const cell = (s: string) => oneLine(s).replace(/\|/g, "\\|");

const def = <T extends Record<string, SubjectDef>>(table: T): T => table;

const TABLE = def({
  coding: {
    instructions: (lang) =>
      `This is a coding topic${lang ? ` (language: ${lang})` : ""}. In every note's "extras" give "examples": 1 to 3 code examples (shown under "Code examples"), ` +
      `each at most ${MAX_CODE_LINES} lines of ${lang ?? "the topic's language"} whose first line is a one-line comment saying what it shows. ` +
      `The code must be correct and runnable as shown, or its first comment must say it is a fragment. Write the code as plain text without code fences, using \\n for line breaks. ` +
      `Also give "mistakes": 2 to 4 short common mistakes (shown under "Common mistakes").`,
    quiz: (lang) =>
      `Include a few "what does this code print" and "fix this bug" questions, each with a small ${lang ?? ""} code block inside the question (fenced with three backticks and the language, written with \\n for line breaks).`,
    shape: () => `{"examples": ["string"], "mistakes": ["string"]}`,
    parse: (raw) => {
      const examples = (Array.isArray(raw.examples) ? raw.examples : [])
        .map((e) => stripFence(typeof e === "string" ? e : isObj(e) ? str(e.code) : ""))
        .filter((c) => c !== "" && c.split("\n").length <= MAX_CODE_LINES)
        .slice(0, 3);
      return examples.length === 0 ? null : { examples, mistakes: strList(raw.mistakes, 4) };
    },
    render: (x) => {
      const lang = typeof x.codeLanguage === "string" ? x.codeLanguage : "";
      const blocks = (x.examples as string[]).flatMap((code, i) => {
        const f = fenceFor(code);
        return [...(i > 0 ? [""] : []), `${f}${lang}`, code, f];
      });
      const out = [["## Code examples", "", ...blocks]];
      const mistakes = x.mistakes as string[];
      if (mistakes.length > 0) out.push(["## Common mistakes", ...mistakes.map((m) => `- ${oneLine(m)}`)]);
      return out.flatMap((s, i) => (i > 0 ? ["", ...s] : s));
    },
  },
  maths: {
    instructions: () =>
      `In every note's "extras" give "formulas": the key formulas as LaTeX without dollar signs (shown under "Formulas"), ` +
      `and "workedExample": 3 to 8 steps of one worked example (shown under "Worked example"). ` +
      `Because the answer is JSON, double every backslash in LaTeX (write \\\\frac, not \\frac).`,
    shape: () => `{"formulas": ["string"], "workedExample": ["string"]}`,
    parse: (raw) => {
      const formulas = strList(raw.formulas, 6), workedExample = strList(raw.workedExample, 8);
      return formulas.length + workedExample.length === 0 ? null : { formulas, workedExample };
    },
    render: (x) => {
      const out: string[][] = [];
      const formulas = x.formulas as string[], steps = x.workedExample as string[];
      if (formulas.length > 0) {
        const f = formulas.map((s) => {
          const t = oneLine(s);
          return t.includes("$") ? t : `$$${t.replace(/^\\\[\s*|\s*\\\]$/g, "")}$$`;
        });
        out.push(["## Formulas", "", ...f.flatMap((s, i) => (i > 0 ? ["", s] : [s]))]);
      }
      if (steps.length > 0) out.push(["## Worked example", ...steps.map(listItem)]);
      return out.flatMap((s, i) => (i > 0 ? ["", ...s] : s));
    },
  },
  science: {
    instructions: () =>
      `In every note's "extras" give "keyTerms": 2 to 6 terms with a short definition each (shown under "Key terms"), ` +
      `and "realWorldExample": one real-world example (shown under "Real-world example").`,
    shape: () => `{"keyTerms": [{"term": "string", "definition": "string"}], "realWorldExample": "string"}`,
    parse: (raw) => {
      const keyTerms = rows(raw.keyTerms, ["term", "definition"], 8, 2), realWorldExample = oneLine(str(raw.realWorldExample));
      return keyTerms.length === 0 && realWorldExample === "" ? null : { keyTerms, realWorldExample };
    },
    render: (x) => {
      const out: string[][] = [];
      const terms = x.keyTerms as Record<string, string>[], example = x.realWorldExample as string;
      if (terms.length > 0) out.push(["## Key terms", ...terms.map((t) => `- **${t.term}**: ${t.definition}`)]);
      if (example) out.push(["## Real-world example", example]);
      return out.flatMap((s, i) => (i > 0 ? ["", ...s] : s));
    },
  },
  language: {
    instructions: () =>
      `In every note's "extras" give "vocabulary": 5 to 10 words from the note, each with its meaning and one example sentence (shown as a table under "Vocabulary").`,
    shape: () => `{"vocabulary": [{"word": "string", "meaning": "string", "example": "string"}]}`,
    parse: (raw) => {
      const vocabulary = rows(raw.vocabulary, ["word", "meaning", "example"], 10, 2);
      return vocabulary.length === 0 ? null : { vocabulary };
    },
    render: (x) => [
      "## Vocabulary", "", "| Word | Meaning | Example sentence |", "| --- | --- | --- |",
      ...(x.vocabulary as Record<string, string>[]).map((r) => `| ${cell(r.word)} | ${cell(r.meaning)} | ${cell(r.example)} |`),
    ],
  },
  history: {
    instructions: () =>
      `In every note's "extras" give "timeline": the dated events from the note in date order (shown under "Timeline"), ` +
      `and "keyPeople": the people involved with one line on each role (shown under "Key people").`,
    shape: () => `{"timeline": [{"date": "string", "event": "string"}], "keyPeople": [{"name": "string", "role": "string"}]}`,
    parse: (raw) => {
      const timeline = rows(raw.timeline, ["date", "event"], 10, 2), keyPeople = rows(raw.keyPeople, ["name", "role"], 10, 1);
      return timeline.length + keyPeople.length === 0 ? null : { timeline, keyPeople };
    },
    render: (x) => {
      const out: string[][] = [];
      const timeline = x.timeline as Record<string, string>[], people = x.keyPeople as Record<string, string>[];
      if (timeline.length > 0) out.push(["## Timeline", ...timeline.map((t) => `- **${t.date}**: ${t.event}`)]);
      if (people.length > 0) out.push(["## Key people", ...people.map((p) => `- **${p.name}**${p.role ? `: ${p.role}` : ""}`)]);
      return out.flatMap((s, i) => (i > 0 ? ["", ...s] : s));
    },
  },
  general: {
    instructions: () => `In every note's "extras" give "example": one concrete example (shown under "## Example").`,
    shape: () => `{"example": "string"}`,
    parse: (raw) => {
      const example = oneLine(str(raw.example));
      return example === "" ? null : { example };
    },
    render: (x) => ["## Example", x.example as string],
  },
});

export type Subject = keyof typeof TABLE;

/** The table, typed so every entry is called through the same `SubjectDef` interface. */
export const SUBJECTS: Record<Subject, SubjectDef> = TABLE;

export function isSubject(v: unknown): v is Subject {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SUBJECTS, v);
}

/** The subject named by a model or a frontmatter value; undefined when it is not one of ours. */
export function toSubject(v: unknown): Subject | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return isSubject(s) ? s : undefined;
}

/**
 * Validates the model's "extras" for `subject`. Never throws. Unusable extras fall back to the
 * general `example`; when there is not even that, the note simply gets no extra section.
 */
export function parseExtras(subject: string, raw: unknown, codeLanguage?: string): Extras | undefined {
  if (!isObj(raw)) return undefined;
  const id: Subject = isSubject(subject) ? subject : "general";
  const lang = id === "coding" ? normaliseLanguage(codeLanguage) : undefined;
  const own = SUBJECTS[id].parse(raw, lang);
  if (own) return { subject: id, ...(lang ? { codeLanguage: lang } : {}), ...own };
  if (id !== "general") {
    const g = SUBJECTS.general.parse(raw);
    if (g) return { subject: "general", ...g };
  }
  return undefined;
}

/** Markdown lines of the extra section(s) of a note ([] when it has none). */
export function renderExtras(extras: Extras | undefined): string[] {
  if (!extras || !isSubject(extras.subject)) return [];
  try { return SUBJECTS[extras.subject].render(extras); } catch { return []; }
}

export interface SubjectInfo { subject?: Subject; codeLanguage?: string; }

/**
 * The subject a job works in: its own when it has one, else the nearest research root's. A coding
 * subject without a language takes the root's language when the root is coding too.
 */
export function resolveSubject(own: SubjectInfo | undefined, inherited: SubjectInfo | undefined): { subject: Subject; codeLanguage?: string } {
  const subject = own?.subject ?? inherited?.subject ?? "general";
  if (subject !== "coding") return { subject };
  const codeLanguage = normaliseLanguage(own?.codeLanguage) ?? (inherited?.subject === "coding" ? normaliseLanguage(inherited.codeLanguage) : undefined);
  return codeLanguage ? { subject, codeLanguage } : { subject };
}
