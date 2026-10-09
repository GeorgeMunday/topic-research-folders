# Topic Research Folders (Obsidian Plugin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user creates a folder whose name ends with the trigger suffix. The plugin researches the topic, suggests subfolders for the user to approve, and fills each one with easy-to-read bullet-point notes. Each note has a "My notes" section and a "Questions & Answers" section. Any PDF inside a research folder is analysed and its information is extracted into notes in the matching subfolders. All of this keeps working when the vault holds hundreds of topics and PDFs.

**Architecture:** A thin Obsidian layer (`main.ts`, modals, settings tab, status bar) turns vault events into jobs on a persistent, concurrency-limited `JobQueue`. The queue runs two job kinds:
- `ResearchFlow` builds a topic.
- `PdfFlow` analyses one PDF.

Each flow gets its dependencies (AI client, vault writer, UI prompts) injected as interfaces. Every module that decides something is pure, has no `obsidian` import, and is tested with Vitest. Those modules cover:
- trigger detection
- names
- prompts
- parsing
- templates
- PDF chunking
- retry/backoff

Research uses the Claude Messages API, optionally with server-side web search. PDFs are sent as base64 `document` blocks, split into chunks with `pdf-lib`.

**Tech Stack:** TypeScript 5, Obsidian plugin API, esbuild (official sample-plugin build), Vitest, `pdf-lib` (pure JS, works on mobile), Web Crypto `crypto.subtle` (SHA-256), Anthropic Messages API (`https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`).

**Spec:** No separate spec doc. The source requirements are quoted verbatim below. The decisions made for them are in Global Constraints.
1. *"a plugin to obsidian where when you make a folder that ends with a * it researches the topic and then suggests folders that would go inside it, inside them are notes that are bullet points as well as easy to read and have an extra section for the user's notes and questions and answers."*
2. *"scalability is a big feature"*
3. *"any pdf in a folder with + is analysed and extracted information into the folders"*

## Global Constraints

### Trigger & folders
- **Trigger suffix:**
  - Configurable; the default is `+`. Obsidian rejects `*` in names, so it cannot be used.
  - Validation rejects `* " \ / < > : | ?` and the empty string.
- **Suffix removal:** The suffix is stripped after triggering (`stripSuffix`, default `true`).
- **Research-root marker:** Every researched folder gets `<Topic> - Overview.md` with frontmatter `research-root: true`. That marker, not the suffix, is how the plugin later recognises a research folder. It therefore survives renames, moves and sync.
- **"Suggests" means the user approves:**
  - A modal lists the suggested subfolders, all checked, with editable names.
  - Nothing is written until the user clicks **Create**.
- **Default counts:** `maxSubfolders` is 6 (range 3–8) and `notesPerSubfolder` is 3 (range 2–5).
- **Nested topics:**
  - Adding the suffix to a folder inside an existing research root researches it as a subtopic.
  - The prompts receive the ancestor topic chain as context.
  - `maxDepth` defaults to 3. A trigger deeper than that shows a Notice and does nothing.

### Note format
Every generated note has these sections, in this order:
1. YAML frontmatter with `topic`, `subtopic`, `created` (`YYYY-MM-DD`) and `tags: [research]`. PDF-derived notes also get `source: "[[<file>.pdf]]"` and `pages: "<range>"`.
2. `# <Note title>`
3. `> <one-sentence plain-English summary>`
4. `## Key points`: 4–10 `- ` bullets, each ≤ 25 words, with nesting allowed one level deep. Bullets in PDF notes end with ` (p. N)`.
5. `## In plain words`: 2–4 short sentences, reading age ~12.
6. `## My notes`: a blank line, then an empty `- ` bullet.
7. `## Questions & Answers`: an empty `**Q:** ` line, followed by an empty `**A:** ` line.

### PDFs
- **What gets analysed:** Every `.pdf` anywhere under a research root (nearest marker ancestor). This includes:
  - PDFs already present when the folder is researched
  - PDFs added, moved or renamed in later
- **Where extracted notes go:**
  - Into the existing subfolder the model picks.
  - A note that fits no subfolder goes into `From PDFs/<suggested name>/`, with no modal. This prevents dropping 50 PDFs from opening 50 dialogs.
- **Source summary:** Each PDF also gets `Sources/<pdf name> - Summary.md`, which:
  - uses the same template
  - links every note made from that PDF
- **Chunking:** Each request carries at most `pdfPagesPerChunk` pages (default 50; the API limit is 100 pages for contexts under 1M tokens) and at most 20 MB of raw bytes (the API limit is 32 MB per request after base64).
- **Unreadable PDFs:** An encrypted or unparseable PDF triggers a Notice that names the file and a skip. It never crashes the queue.
- **Duplicates:** PDFs are de-duplicated by SHA-256 of their bytes, recorded in `processedPdfs`. A moved, renamed or re-added PDF is never processed twice.
- **Cost guard:** If one batch of new PDFs totals more than `confirmAbovePages` pages (default 200), a confirm modal shows the page count before anything is sent.

### Scalability
- **Concurrency:** All API work runs through one `JobQueue` with `maxConcurrent` set to 2 by default (range 1–5).
- **Retries:**
  - Retried: 429, 500, 502, 503, 504 and 529, plus network errors.
  - Not retried: any other 4xx.
  - Up to `maxRetries` attempts (default 4).
  - Waits honour `retry-after`; otherwise they use exponential backoff of 2s, 4s, 8s, 16s with ±20% jitter.
- **Persistence:** The queue is saved to `data.json` after every change and resumed after `onLayoutReady`.
- **Checkpoints:** Research jobs save `approved` subfolders and the `done` subfolders. A resumed job never re-asks or rewrites finished work.
- **Event cost:** Each vault event is O(folder depth), and the plugin never scans the whole vault. Root lookup walks parent folders only.
- **Status bar:** Shows `Research: <running>/<queued>`. A **Cancel all research jobs** command empties the queue; running jobs stop at their next checkpoint.

### General
- **Overwriting:** Existing files and folders are never overwritten. On a collision, ` (2)`, ` (3)` and so on is appended.
- **API key:**
  - Stored only in `data.json`.
  - Never logged.
  - Entered in a password field.
- **Model and search:**
  - Default model: `claude-sonnet-5-5`.
  - Web search tool: `{"type":"web_search_20250305","name":"web_search","max_uses":5}` for research jobs only, controlled by `useWebSearch` (default on).
- **`manifest.json`:**
  - `id`: `"topic-research-folders"`
  - `minAppVersion`: `"1.5.0"`
  - `isDesktopOnly`: `false`

## Review Focus

1. **Vault load fires `create` for every existing folder and file.** Startup must trigger nothing and enqueue nothing. Events count only after `onLayoutReady`, and resumed jobs come from `data.json`, not events. Pinned by Task 9 `ignores events before ready` and Task 10 `ignores pdf events before ready`.
2. **Dropping 50 PDFs at once.**
   - Expected:
     - At most `maxConcurrent` requests in flight.
     - No modal per PDF.
     - One cost confirmation for the batch.
     - The status bar counts down.
   - Pinned by Task 5 `never exceeds concurrency` and Task 10 `batches confirmation for simultaneous drops`.
3. **A 429/529 storm or a laptop going offline mid-batch.**
   - Expected:
     - Backoff honours `retry-after`.
     - After retries run out, the job fails with a Notice and the others continue.
     - On restart, unfinished jobs resume.
   - Pinned by Task 5 `honours retry-after`, `gives up after maxRetries` and `restores persisted jobs`.
4. **A 400-page textbook, a 60 MB scan, or an encrypted PDF.**
   - Large files are split into chunks within both limits.
   - A single page over 20 MB is skipped with a Notice.
   - An encrypted PDF is skipped with a Notice.
   - Pinned by Task 8 tests.
5. **The same PDF copied into two folders or moved later.** It must not be processed twice. Pinned by Task 10 `skips already processed hash`.

---

## File Structure

```
topic-research-folders/
  manifest.json, package.json, tsconfig.json, esbuild.config.mjs, vitest.config.ts, versions.json
  src/
    main.ts                   plugin entry: wiring, event listeners, commands, status bar
    settings.ts               Settings, DEFAULT_SETTINGS, validateSuffix, SettingsTab
    types.ts                  shared types
    trigger.ts                pure: suffix detection
    names.ts                  pure: sanitiseName, uniqueName
    jobs/queue.ts             JobQueue: concurrency, retry/backoff, cancel, persistence hook
    jobs/backoff.ts           pure: isRetryable, delayFor
    research/prompts.ts       pure: outline, notes, pdf prompts
    research/parse.ts         pure: extractJson, parseOutline, parseNotes, parsePdfExtraction
    research/claudeClient.ts  ResearchClient over injected HttpFn
    pdf/chunk.ts              pure planning + pdf-lib split, page count, hash
    vault/noteTemplate.ts     pure: renderNote, renderOverview, renderSourceSummary
    vault/writer.ts           VaultWriter over VaultLike; findResearchRoot
    flows/researchFlow.ts     ResearchFlow
    flows/pdfFlow.ts          PdfFlow
    ui/SuggestionModal.ts     Approver
    ui/ConfirmModal.ts        Confirmer
  tests/mocks/obsidian.ts, tests/fixtures/*.pdf (generated in Task 8), tests/*.test.ts
```

## Shared Types (`src/types.ts`, created in Task 1)

```ts
export interface SubfolderSuggestion { name: string; why: string; }
export interface Outline { topic: string; summary: string; subfolders: SubfolderSuggestion[]; }
export interface NoteContent { title: string; summary: string; keyPoints: string[]; plainWords: string; }
export interface SubfolderNotes { subfolder: string; notes: NoteContent[]; }
export interface ExtractedNote extends NoteContent { subfolder: string; isNew: boolean; pages: string; }
export interface PdfExtraction { summary: string; notes: ExtractedNote[]; }
export type Job =
  | { id: string; kind: "research"; path: string; approved?: SubfolderSuggestion[]; done: string[] }
  | { id: string; kind: "pdf"; path: string };
```

`keyPoints` entries starting with two spaces are nested bullets.

---

### Task 1: Scaffold + trigger detection

**Files:**
- Create: `manifest.json`, `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `versions.json`, `src/types.ts`, `src/trigger.ts`, `tests/mocks/obsidian.ts`
- Test: `tests/trigger.test.ts`

**Interfaces:**
- Produces:
  - `isTriggerName(name: string, suffix: string): boolean`
  - `topicFromName(name: string, suffix: string): string`
  - `strippedPath(path: string, suffix: string): string`
  - all types in `src/types.ts`

- [ ] **Step 1: Scaffold the project.**
  - Copy the build config from `obsidianmd/obsidian-sample-plugin`.
  - Deps: `pdf-lib`.
  - DevDeps: `vitest`, `obsidian`, `typescript`, `esbuild`, `@types/node`.
  - Scripts: `dev`, `build`, and `test: "vitest run"`.
  - Configure Vitest to alias `obsidian` to `tests/mocks/obsidian.ts`. The mock exports empty `Plugin`, `Modal`, `Notice`, `PluginSettingTab`, `Setting`, `TFolder`, `TFile` and a `requestUrl` stub.
- [ ] **Step 2: Write the failing test**

```ts
test("detects suffix", () => {
  expect(isTriggerName("Black holes+", "+")).toBe(true);
  expect(isTriggerName("Black holes", "+")).toBe(false);
  expect(isTriggerName("+", "+")).toBe(false);
  expect(isTriggerName("Notes  +  ", "+")).toBe(true);
});
test("topic strips one suffix", () => {
  expect(topicFromName("Black holes+", "+")).toBe("Black holes");
  expect(topicFromName("C++", "+")).toBe("C+");
});
test("strippedPath keeps parent", () => {
  expect(strippedPath("Science/Black holes+", "+")).toBe("Science/Black holes");
});
```

- [ ] **Step 3: Run the test.** `npx vitest run tests/trigger.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the three functions.
- [ ] **Step 5: Verify.** Run the test again (expected: PASS), then `npm run build` (expected: `main.js` is built).
- [ ] **Step 6: Commit** with message `feat: scaffold plugin and trigger detection`.

---

### Task 2: Safe names

**Files:**
- Create: `src/names.ts`
- Test: `tests/names.test.ts`

**Interfaces:**
- Produces:
  - `sanitiseName(raw: string): string`
  - `uniqueName(base: string, exists: (candidate: string) => boolean): string`

- [ ] **Step 1: Write the failing test**

```ts
test("removes illegal chars", () => {
  expect(sanitiseName("C++ / Templates")).toBe("C++ - Templates");
  expect(sanitiseName("What is: X?")).toBe("What is - X");
  expect(sanitiseName('  a*b"c<d>e|f  ')).toBe("a b c d e f");
  expect(sanitiseName("...hidden")).toBe("hidden");
  expect(sanitiseName("???")).toBe("Untitled");
  expect(sanitiseName("x".repeat(200)).length).toBe(100);
});
test("uniqueName appends counter", () => {
  const taken = new Set(["Basics", "Basics (2)"]);
  expect(uniqueName("Basics", n => taken.has(n))).toBe("Basics (3)");
});
```

- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement** with these rules:
  1. Replace `/`, `\` and `:` with ` - `.
  2. Replace `* " < > | ? # ^ [ ]` with a space.
  3. Collapse runs of spaces and repeated ` - `.
  4. Trim spaces, dots and dashes from both ends.
  5. Cap the length at 100 characters.
  6. If the result is empty, return `"Untitled"`.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: sanitise and de-duplicate names`.

---

### Task 3: Note templates

**Files:**
- Create: `src/vault/noteTemplate.ts`
- Test: `tests/noteTemplate.test.ts`

**Interfaces:**
- Consumes: types
- Produces:
  - `renderNote(note: NoteContent, ctx: { topic: string; subtopic: string; date: string; source?: string; pages?: string }): string`
  - `renderOverview(outline: Outline, links: { subfolder: string; noteTitles: string[] }[], date: string): string`
  - `renderSourceSummary(pdfName: string, topic: string, summary: string, links: { subfolder: string; title: string }[], date: string): string`

- [ ] **Step 1: Write the failing tests.** Exact copy:

```ts
const note = { title: "Event horizon", summary: "The point of no return.",
  keyPoints: ["Boundary around a black hole", "  Light cannot escape"], plainWords: "Cross it and you can't come back." };
test("renders all sections in order", () => {
  expect(renderNote(note, { topic: "Black holes", subtopic: "Anatomy", date: "2026-10-08" })).toBe(
`---
topic: "Black holes"
subtopic: "Anatomy"
created: 2026-10-08
tags: [research]
---

# Event horizon

> The point of no return.

## Key points
- Boundary around a black hole
  - Light cannot escape

## In plain words
Cross it and you can't come back.

## My notes

- 

## Questions & Answers

**Q:** 
**A:** 
`);
});
test("pdf notes carry source and pages", () => {
  const md = renderNote(note, { topic: "T", subtopic: "S", date: "2026-10-08", source: "paper.pdf", pages: "3-5" });
  expect(md).toContain('source: "[[paper.pdf]]"\npages: "3-5"\ntags: [research]');
});
test("overview is marked as research root and links notes", () => {
  const md = renderOverview({ topic: "Black holes", summary: "S", subfolders: [] },
    [{ subfolder: "Anatomy", noteTitles: ["Event horizon"] }], "2026-10-08");
  expect(md).toContain("research-root: true");
  expect(md).toContain("- **Anatomy**\n  - [[Event horizon]]");
  expect(md).toContain("## Questions & Answers");
});
test("source summary links extracted notes", () => {
  const md = renderSourceSummary("paper.pdf", "T", "Sum", [{ subfolder: "A", title: "X" }], "2026-10-08");
  expect(md).toContain('source: "[[paper.pdf]]"'); expect(md).toContain("[[X]]");
});
test("quotes in frontmatter escaped", () => {
  expect(renderNote(note, { topic: 'The "Big" one', subtopic: "A", date: "2026-10-08" }))
    .toContain('topic: "The \\"Big\\" one"');
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions:
  - `renderNote` places `source` and `pages` after `created` and before `tags`.
  - `renderOverview` adds `research-root: true` after `created`.
  - `renderSourceSummary` titles its note `<pdf name> - Summary`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: note, overview and source templates`.

---

### Task 4: Prompts and response parsing

**Files:**
- Create: `src/research/prompts.ts`, `src/research/parse.ts`
- Test: `tests/parse.test.ts`, `tests/prompts.test.ts`

**Interfaces:**
- Produces:
  - `outlinePrompt(topic: string, parents: string[], max: number): string`
  - `notesPrompt(topic: string, parents: string[], subfolder: SubfolderSuggestion, count: number): string`
  - `pdfPrompt(topic: string, subfolders: string[], pageOffset: number): string`
  - `extractJson(text: string): unknown`
  - `parseOutline(text: string, max: number): Outline`
  - `parseNotes(text: string, count: number): NoteContent[]`
  - `parsePdfExtraction(text: string, subfolders: string[]): PdfExtraction`
  - `class ParseError extends Error`

**Prompt requirements:**
- All prompts:
  - Demand **JSON only** in the shape shown inline.
  - Use no markdown inside strings.
  - Keep key points ≤ 25 words.
  - Ask for `plainWords` written "as if explaining to a curious 12-year-old".
- Outline prompt:
  - Asks for 3–`max` non-overlapping subfolders, each `name` ≤ 5 words.
  - When `parents` is non-empty, says "This is a subtopic of: A > B" and asks for no overlap with the parents.
- PDF prompt:
  - Lists the existing subfolders.
  - Each note must set `subfolder` to one of them exactly, or set `isNew: true` with a new name ≤ 5 words.
  - Notes are grouped by idea, not by page.
  - Every key point ends with `(p. N)`, using absolute page numbers (chunk page + `pageOffset`).
  - Information must come only from the document.

- [ ] **Step 1: Write the failing tests**

```ts
test("extracts fenced JSON", () => expect(extractJson('x\n```json\n{"a":1}\n```')).toEqual({ a: 1 }));
test("extracts balanced object from prose", () => expect(extractJson('Sure! {"a":{"b":"}"}} done')).toEqual({ a: { b: "}" } }));
test("truncated JSON throws", () => expect(() => extractJson('{"a": [1, 2')).toThrow(ParseError));
test("parseOutline caps and drops blanks", () => {
  const subs = [...Array(9)].map((_, i) => ({ name: `S${i}`, why: "w" })).concat({ name: " ", why: "w" });
  expect(parseOutline(JSON.stringify({ topic: "T", summary: "s", subfolders: subs }), 6).subfolders).toHaveLength(6);
});
test("parseOutline with zero subfolders throws", () =>
  expect(() => parseOutline('{"topic":"T","summary":"s","subfolders":[]}', 6)).toThrow(ParseError));
test("parseNotes rejects missing keyPoints", () =>
  expect(() => parseNotes('{"notes":[{"title":"x","summary":"s","plainWords":"p"}]}', 1)).toThrow(ParseError));
test("parsePdfExtraction marks unknown subfolder as new", () => {
  const r = parsePdfExtraction(JSON.stringify({ summary: "s", notes: [
    { subfolder: "anatomy", isNew: false, title: "A", summary: "s", keyPoints: ["k (p. 1)"], plainWords: "p", pages: "1" },
    { subfolder: "Jets", isNew: false, title: "B", summary: "s", keyPoints: ["k (p. 2)"], plainWords: "p", pages: "2" } ] }),
    ["Anatomy"]);
  expect(r.notes[0]).toMatchObject({ subfolder: "Anatomy", isNew: false }); // case-insensitive match
  expect(r.notes[1]).toMatchObject({ subfolder: "Jets", isNew: true });
});
test("subtopic prompt names parent chain", () =>
  expect(outlinePrompt("Event horizon", ["Black holes", "Anatomy"], 6)).toContain("Black holes > Anatomy"));
test("pdf prompt lists subfolders and offset", () => {
  const p = pdfPrompt("T", ["Anatomy", "History"], 50);
  expect(p).toContain("Anatomy"); expect(p).toContain("51"); expect(p).toMatch(/JSON only/i);
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `extractJson`:
    1. Try a fenced code block first.
    2. Otherwise, take the first balanced `{…}`, respecting strings and escapes.
    3. Wrap any parse failure in `ParseError`.
  - Validate by hand; no schema library.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: prompts and robust JSON parsing`.

---

### Task 5: Job queue (concurrency, retry, cancel, persistence)

**Files:**
- Create: `src/jobs/backoff.ts`, `src/jobs/queue.ts`
- Test: `tests/backoff.test.ts`, `tests/queue.test.ts`

**Interfaces:**
- Consumes: `Job` (types.ts)
- Produces:
  ```ts
  // backoff.ts
  export function isRetryable(err: unknown): boolean;            // ApiError status in [429,500,502,503,504,529] or TypeError (network)
  export function delayFor(attempt: number, retryAfterMs: number | undefined, rand: () => number): number;
  // queue.ts
  export type Runner = (job: Job, signal: { cancelled: boolean }, checkpoint: (j: Job) => Promise<void>) => Promise<void>;
  export interface QueueOpts { maxConcurrent: () => number; maxRetries: () => number;
    persist: (jobs: Job[]) => Promise<void>; sleep: (ms: number) => Promise<void>; rand: () => number;
    onChange: (running: number, queued: number) => void; onFailed: (job: Job, err: unknown) => void; }
  export class JobQueue {
    constructor(run: Runner, opts: QueueOpts);
    add(job: Job): boolean;           // false if a job with same kind+path is queued or running
    restore(jobs: Job[]): void;       // re-add persisted jobs
    cancelAll(): void;                // clears queue, sets signal.cancelled on running jobs
    idle(): Promise<void>;            // resolves when nothing queued or running (tests)
  }
  ```
  `ApiError` is declared here (`class ApiError extends Error { status: number; retryAfterMs?: number }`) and re-exported by the client.

- [ ] **Step 1: Write the failing tests**

```ts
test("delayFor: retry-after wins, else 2^n*2s with ±20% jitter", () => {
  expect(delayFor(1, 7000, () => 0.5)).toBe(7000);
  expect(delayFor(1, undefined, () => 0.5)).toBe(2000);
  expect(delayFor(3, undefined, () => 1)).toBe(9600);   // 8000 * 1.2
  expect(delayFor(3, undefined, () => 0)).toBe(6400);   // 8000 * 0.8
});
test("isRetryable", () => {
  expect(isRetryable(new ApiError("x", 429))).toBe(true);
  expect(isRetryable(new ApiError("x", 401))).toBe(false);
  expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
});
test("never exceeds concurrency", async () => {
  let live = 0, peak = 0;
  const q = new JobQueue(async () => { live++; peak = Math.max(peak, live); await tick(); live--; }, opts({ maxConcurrent: 2 }));
  for (let i = 0; i < 20; i++) q.add(pdfJob(`p${i}.pdf`));
  await q.idle(); expect(peak).toBe(2);
});
test("dedupes same kind+path", () => { /* second add returns false */ });
test("honours retry-after", async () => {
  // runner throws ApiError(429, retryAfterMs 5000) once then succeeds → sleep called with 5000, job ran twice
});
test("gives up after maxRetries and continues others", async () => {
  // job A always 503, job B ok, maxRetries 4 → A attempted 5 times, onFailed(A), B completed
});
test("non-retryable fails immediately", async () => { /* 401 → attempted once, onFailed */ });
test("persists on every change and restores", async () => {
  // persist receives queued jobs (without completed); new queue.restore(saved) runs them
});
test("checkpoint persists updated job state", async () => { /* runner calls checkpoint({...job, done:["A"]}) → last persist contains done ["A"] */ });
test("cancelAll empties queue and flags running", async () => { /* queued never run; running sees signal.cancelled */ });
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The queue is FIFO.
  - Persist the queued jobs plus the running jobs; completed and failed jobs drop out.
  - The `cancelled` flag is checked by runners at their checkpoints.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: persistent job queue with retry and concurrency limit`.

---

### Task 6: Claude client

**Files:**
- Create: `src/research/claudeClient.ts`
- Test: `tests/claudeClient.test.ts`

**Interfaces:**
- Consumes: prompts and parsers (Task 4), `ApiError` (Task 5)
- Produces:
  ```ts
  export interface ResearchClient {
    outline(topic: string, parents: string[], max: number): Promise<Outline>;
    notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number): Promise<NoteContent[]>;
    extractPdf(topic: string, subfolders: string[], pdfBase64: string, pageOffset: number): Promise<PdfExtraction>;
  }
  export type HttpFn = (req: { url: string; method: "POST"; headers: Record<string, string>; body: string })
    => Promise<{ status: number; json: any; headers: Record<string, string> }>;
  export class ClaudeClient implements ResearchClient {
    constructor(http: HttpFn, cfg: () => { apiKey: string; model: string; useWebSearch: boolean });
  }
  ```

- [ ] **Step 1: Write the failing tests** using a fake `HttpFn` that records requests.

```ts
test("research request: headers, model, web search", async () => {
  /* outline() → url https://api.anthropic.com/v1/messages, x-api-key, anthropic-version 2023-06-01,
     body.model, body.tools[0] deep-equals {type:"web_search_20250305",name:"web_search",max_uses:5} */
});
test("no tools when web search off", async () => { /* body.tools undefined */ });
test("pdf request: document block first, no web search", async () => {
  // extractPdf → messages[0].content[0] equals
  // { type:"document", source:{ type:"base64", media_type:"application/pdf", data:"QUJD" } }
  // content[1].type === "text"; body.tools undefined
});
test("uses the LAST text block containing '{'", async () => { /* search results interleave text blocks */ });
test("non-200 → ApiError with status, API message and retry-after ms", async () => {
  // 429, headers {"retry-after":"12"}, json {error:{message:"rate_limit_error"}} → status 429, retryAfterMs 12000
});
test("reads current settings each call", async () => { /* cfg() changed between calls → new key used */ });
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** with these `max_tokens` values:

  | Request | `max_tokens` |
  |---|---|
  | outline | 4096 |
  | notes | 8192 |
  | pdf | 16000 |

  Header lookup is case-insensitive.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: Claude client with PDF document support`.

---

### Task 7: Vault writer + research-root lookup

**Files:**
- Create: `src/vault/writer.ts`
- Test: `tests/writer.test.ts`

**Interfaces:**
- Consumes: names (Task 2), templates (Task 3)
- Produces:
  ```ts
  export interface VaultLike {
    exists(path: string): boolean;
    read(path: string): Promise<string>;
    createFolder(path: string): Promise<void>;
    createFile(path: string, content: string): Promise<void>;
  }
  export class VaultWriter {
    constructor(vault: VaultLike);
    writeSubfolder(parent: string, topic: string, sn: SubfolderNotes, date: string): Promise<{ folder: string; noteTitles: string[] }>;
    writeOverview(parent: string, outline: Outline, links: { subfolder: string; noteTitles: string[] }[], date: string): Promise<string>;
    writeExtracted(root: string, topic: string, pdfName: string, ex: PdfExtraction, date: string): Promise<{ subfolder: string; title: string }[]>;
    findResearchRoot(path: string): Promise<{ root: string; topic: string; parents: string[] } | null>;
    listSubfolders(root: string): string[];   // provided by VaultLike adapter via children; see Task 11
  }
  ```
  `VaultLike` also gets `children(path: string): { name: string; isFolder: boolean }[]`.

- [ ] **Step 1: Write the failing tests** with an in-memory `VaultLike`.

```ts
test("creates subfolder and one .md per note", async () => { /* Black holes/Anatomy/Event horizon.md contains "## Questions & Answers" */ });
test("never overwrites existing folder or file", async () => { /* existing Anatomy → "Anatomy (2)"; original file untouched */ });
test("returns sanitised titles used as filenames", async () => { /* "What is: X?" → "What is - X" */ });
test("overview path is '<Topic> - Overview.md'", async () => {});
test("writeExtracted routes notes and writes source summary", async () => {
  // existing note → Black holes/Anatomy/<title>.md with source frontmatter
  // isNew note "Jets" → Black holes/From PDFs/Jets/<title>.md
  // summary → Black holes/Sources/paper - Summary.md linking both
  // existing subfolder missing on disk (user deleted it) → treated as new
});
test("findResearchRoot walks up to nearest marked overview", async () => {
  // Black holes/Black holes - Overview.md has research-root: true
  // Black holes/Anatomy/Anatomy - Overview.md has research-root: true (nested topic)
  // findResearchRoot("Black holes/Anatomy/Deep/x.pdf") → { root:"Black holes/Anatomy", topic:"Anatomy", parents:["Black holes"] }
  // findResearchRoot("Other/x.pdf") → null
});
test("an overview without the marker is ignored", async () => {});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `findResearchRoot` checks only ancestors of `path`, in order: `<folder>/<folder name> - Overview.md`, frontmatter line `research-root: true`.
  - Collect ancestor roots for `parents`, outermost first.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: vault writer, PDF note routing and research-root lookup`.

---

### Task 8: PDF chunking and hashing

**Files:**
- Create: `src/pdf/chunk.ts`
- Test: `tests/chunk.test.ts`; fixtures generated in a `beforeAll` with `pdf-lib`

**Interfaces:**
- Produces:
  ```ts
  export function planChunks(pageSizes: number[], maxPages: number, maxBytes: number):
    { ranges: [number, number][]; oversized: number[] };           // pure; 0-based inclusive ranges; oversized = pages that alone exceed maxBytes
  export async function inspectPdf(bytes: ArrayBuffer): Promise<{ pageCount: number }>;   // throws PdfError("encrypted"|"unreadable")
  export async function splitPdf(bytes: ArrayBuffer, maxPages: number, maxBytes: number):
    Promise<{ chunks: { base64: string; firstPage: number; lastPage: number }[]; skippedPages: number[] }>;
  export async function sha256(bytes: ArrayBuffer): Promise<string>;   // hex
  export class PdfError extends Error { reason: "encrypted" | "unreadable" }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("planChunks respects page limit", () =>
  expect(planChunks(Array(120).fill(1000), 50, 1e9).ranges).toEqual([[0, 49], [50, 99], [100, 119]]));
test("planChunks respects byte limit", () =>
  expect(planChunks([6, 6, 6, 6], 50, 12).ranges).toEqual([[0, 1], [2, 3]]));
test("planChunks reports single oversized page", () =>
  expect(planChunks([5, 30, 5], 50, 12)).toEqual({ ranges: [[0, 0], [2, 2]], oversized: [1] }));
test("splitPdf: 120-page fixture → 3 chunks with correct page numbers", async () => {
  const r = await splitPdf(fixture120, 50, 20_000_000);
  expect(r.chunks.map(c => [c.firstPage, c.lastPage])).toEqual([[1, 50], [51, 100], [101, 120]]); // 1-based for prompts
  expect((await inspectPdf(b64ToBuf(r.chunks[1].base64))).pageCount).toBe(50);
});
test("encrypted pdf → PdfError encrypted", async () => {});
test("garbage bytes → PdfError unreadable", async () => {});
test("sha256 is stable hex", async () => expect(await sha256(new TextEncoder().encode("abc").buffer))
  .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Estimate per-page size by saving a single-page copy of each page. That is O(n) copies, which is acceptable at ≤ 600 pages.
  - Above 600 pages, fall back to `totalBytes / pageCount`.
  - `planChunks` is greedy.
  - Use `pdf-lib` `PDFDocument.load(bytes, { ignoreEncryption: false })` and `copyPages`.
  - Do base64 conversion in 32 KB slices to avoid stack overflow.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: PDF chunking within API limits and content hashing`.

---

### Task 9: Research flow

**Files:**
- Create: `src/flows/researchFlow.ts`
- Test: `tests/researchFlow.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 6, 7
- Produces:
  ```ts
  export interface Approver { approve(outline: Outline): Promise<SubfolderSuggestion[] | null>; }
  export interface Notifier { info(msg: string): void; error(msg: string): void; }
  export interface ResearchDeps {
    client: () => ResearchClient | null; writer: VaultWriter; approver: Approver; notify: Notifier;
    rename: (from: string, to: string) => Promise<void>; settings: () => Settings; today: () => string;
    enqueue: (job: Job) => boolean; listPdfs: (folder: string) => string[];
  }
  export class ResearchFlow {
    constructor(deps: ResearchDeps);
    markReady(): void;
    onFolderEvent(path: string): Promise<void>;    // create or rename → strips suffix, enqueues a research job
    run: Runner;                                   // executes a research job (passed to JobQueue)
  }
  ```

- [ ] **Step 1: Write the failing tests** with all dependencies faked and a real `JobQueue` using an instant `sleep`.

```ts
test("ignores events before ready", async () => {});
test("ignores non-trigger names", async () => {});
test("triggers on rename into suffix", async () => {});
test("missing API key → error notice, nothing renamed or queued", async () => {});
test("strips suffix then queues job for the stripped path", async () => {});
test("writes only approved subfolders, then overview", async () => {});
test("cancelled approval writes nothing", async () => {});
test("nested: trigger inside research root passes parents to prompts", async () => {
  // root "Black holes" exists; "Black holes/Anatomy+" → outline("Anatomy", ["Black holes"], 6)
});
test("beyond maxDepth → notice, no job", async () => {});
test("checkpoints approved + done; resumed job skips approval and done subfolders", async () => {
  // run job {approved:[A,B,C], done:["A"]} → approver not called, notes() called for B and C only
});
test("one subfolder failing does not abort others", async () => {});
test("stops at next subfolder when cancelled", async () => {});
test("after finishing, enqueues a pdf job for each PDF under the root", async () => {
  // listPdfs returns ["Black holes/a.pdf","Black holes/x/b.pdf"] → enqueue called with 2 pdf jobs
});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `onFolderEvent` does only cheap work; all API work happens in `run`, inside the queue.
  - `run` follows this order:
    1. `outline` (skip if the job already has `approved`)
    2. approve, then checkpoint
    3. for each approved subfolder not in `done`: check cancel, call `notes`, call `writeSubfolder`, then checkpoint
    4. `writeOverview` (use `uniqueName` if it already exists)
    5. enqueue the PDF jobs
    6. post the summary notice
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: research flow with nesting and resumable checkpoints`.

---

### Task 10: PDF flow

**Files:**
- Create: `src/flows/pdfFlow.ts`
- Test: `tests/pdfFlow.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7, 8; `Notifier` (Task 9)
- Produces:
  ```ts
  export interface Confirmer { confirm(message: string): Promise<boolean>; }
  export interface PdfDeps {
    client: () => ResearchClient | null; writer: VaultWriter; notify: Notifier; confirm: Confirmer;
    readBinary: (path: string) => Promise<ArrayBuffer>; settings: () => Settings; today: () => string;
    enqueue: (job: Job) => boolean; processed: () => Record<string, { path: string; date: string }>;
    markProcessed: (hash: string, path: string) => Promise<void>;
    setTimer: (fn: () => void, ms: number) => void;
  }
  export class PdfFlow {
    constructor(deps: PdfDeps);
    markReady(): void;
    onFileEvent(path: string): Promise<void>;   // create or rename of a .pdf
    run: Runner;
  }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("ignores pdf events before ready", async () => {});
test("ignores pdf outside any research root", async () => {});
test("ignores non-pdf files", async () => {});
test("batches confirmation for simultaneous drops", async () => {
  // 30 PDFs × 10 pages arrive within 2s; confirmAbovePages 200 → ONE confirm mentioning "30 PDFs" and "300 pages"
  // declined → nothing enqueued; accepted → 30 jobs enqueued
});
test("under threshold → enqueued without confirm", async () => {});
test("skips already processed hash", async () => { /* processed() has the hash → client not called, no notice spam */ });
test("chunks big PDF and passes page offsets", async () => {
  // 120 pages, chunk 50 → extractPdf called 3 times with offsets 0, 50, 100; results merged before writing
});
test("same-titled notes from different chunks are merged", async () => {
  // keyPoints concatenated, deduped, capped at 10
});
test("writes via writeExtracted then marks processed", async () => {});
test("encrypted pdf → notice naming file, job completes without throwing", async () => {});
test("oversized single page → notice lists skipped pages, rest processed", async () => {});
test("pdf deleted before its job runs → silently skipped", async () => {});
```

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `onFileEvent`:
    1. Find the research root.
    2. Hash the file; if it is already processed, return.
    3. Add it to a pending batch and (re)start a 2s timer.
    4. On flush, sum the page counts via `inspectPdf`.
    5. Confirm if the total is over the threshold.
    6. Enqueue one job per PDF.
  - `run`:
    1. Re-check the hash.
    2. Run `splitPdf`.
    3. Call `extractPdf` per chunk, sequentially within one PDF so offsets stay ordered. Concurrency comes from running several PDFs at once.
    4. Merge the results.
    5. Call `writeExtracted`.
    6. Call `markProcessed`.
    7. Post the notice "Extracted N notes from <file>".
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat: PDF analysis flow with batching and dedupe`.

---

### Task 11: Obsidian wiring — settings, modals, status bar, events

**Files:**
- Create: `src/settings.ts`, `src/ui/SuggestionModal.ts`, `src/ui/ConfirmModal.ts`, `src/main.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Settings { apiKey: string; model: string; useWebSearch: boolean; triggerSuffix: string; stripSuffix: boolean;
    maxSubfolders: number; notesPerSubfolder: number; maxDepth: number; maxConcurrent: number; maxRetries: number;
    processPdfs: boolean; pdfPagesPerChunk: number; confirmAbovePages: number; }
  export interface PluginData { settings: Settings; jobs: Job[]; processedPdfs: Record<string, { path: string; date: string }>; }
  export const DEFAULT_SETTINGS: Settings;
  export function validateSuffix(s: string): string | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
test("defaults", () => expect(DEFAULT_SETTINGS).toEqual({ apiKey: "", model: "claude-sonnet-5-5", useWebSearch: true,
  triggerSuffix: "+", stripSuffix: true, maxSubfolders: 6, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 2,
  maxRetries: 4, processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200 }));
test("suffix validation", () => {
  expect(validateSuffix("+")).toBeNull();
  expect(validateSuffix("*")).toMatch(/not allowed/);
  expect(validateSuffix("")).toMatch(/empty/);
});
test("loadData merges partial saved data with defaults", () => { /* old data.json without new keys → defaults filled */ });
```

- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement `settings.ts`.**
  - The settings tab has a password field for the key.
  - Sliders and their ranges:

    | Setting | Range |
    |---|---|
    | `maxSubfolders` | 3–8 |
    | `notesPerSubfolder` | 2–5 |
    | `maxDepth` | 1–5 |
    | `maxConcurrent` | 1–5 |
    | `pdfPagesPerChunk` | 10–100 |

  - `confirmAbovePages` is a number field.
  - The suffix field shows its validation error and refuses to save an invalid value.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Implement the modals.**
  - `SuggestionModal`:
    - Shows the summary.
    - One row per suggestion: a checked checkbox, an editable name sanitised on save, and the reason (`why`) in muted text.
    - **Create** is disabled when no row is checked.
    - **Cancel** and Esc both return `null`.
  - `ConfirmModal`: **Continue** and **Cancel**; Esc means cancel.
- [ ] **Step 6: Implement `main.ts`.**
  - **Adapters:**
    - `requestUrl` adapted to `HttpFn` with `throw: false`.
    - `VaultLike` over `app.vault`, with `children` taken from `TFolder.children`.
    - `listPdfs` walks only the given folder.
    - `rename` through `app.fileManager.renameFile`.
  - **Queue setup:** One `JobQueue` dispatches by `job.kind` to `researchFlow.run` or `pdfFlow.run`. Its `persist` callback saves `PluginData.jobs`, and its `onFailed` callback shows a Notice naming the job.
  - **Event handlers:** `registerEvent` for vault `create` and `rename`:
    - Folders go to `researchFlow.onFolderEvent`.
    - `.pdf` files go to `pdfFlow.onFileEvent`, gated by `processPdfs`.
  - **Startup:** `app.workspace.onLayoutReady` calls `markReady()` on both flows, then `queue.restore(data.jobs)`.
  - **Status bar:** Shows `Research: r/q` and is hidden when idle.
  - **Commands:**
    - **Research this folder** (also in the folder context menu) researches a folder without needing the suffix.
    - **Analyse PDFs in this folder** forces all PDFs under the root to be re-queued; it clears their hashes first.
    - **Cancel all research jobs** empties the queue.
- [ ] **Step 7: Verify.** `npm test` (expected: all PASS), then `npm run build` (expected: no errors).
- [ ] **Step 8: Manual check in a test vault.**
  1. Create `Black holes+`.
     - The modal opens.
     - After approving, the folder is renamed.
     - The notes have every section.
     - The overview links resolve.
  2. Create `Black holes/Anatomy/Event horizon+`. The nested outline mentions the parent chain.
  3. Drop 3 small PDFs into `Black holes/`.
     - Notes appear in the matching subfolders.
     - Unmatched notes appear in `From PDFs/`.
     - `Sources/<name> - Summary.md` exists for each PDF.
     - The status bar counts down.
  4. Copy one PDF into a subfolder. It is not reprocessed.
  5. Drop a 300-page PDF.
     - A confirm modal shows the page count.
     - It is processed in 6 chunks.
     - Page refs in the notes go above 250.
  6. Drop 10 PDFs and quit Obsidian mid-way. After a restart, the remaining jobs resume and none duplicate.
  7. Set the API key to blank. You get an error Notice and nothing is written.
- [ ] **Step 9: Commit** with message `feat: settings, modals, status bar and vault wiring`.

---

# Addendum: Tasks 12–13 (model picker, loading feedback)

> Tasks 1–11 are implemented. These two tasks extend them. Same rules as above: test-first, `npm test` and `npm run build` both pass before a task is done, no real API key in code, tests or commits, tests use fake HTTP functions only.

## Global Constraints (Tasks 12–13)

- **List Models API** (verified against the API docs on 2026-10-09):
  - `GET https://api.anthropic.com/v1/models?limit=100`, headers `x-api-key` and `anthropic-version: 2023-06-01`, via Obsidian `requestUrl` with `throw: false`.
  - Next page: same URL plus `&after_id=<last_id>` while `has_more` is true; stop after 10 pages.
  - Model fields used: `id`, `display_name`, `created_at`, `lifecycle` (`"active" | "deprecated" | "retired"`, treated as `"active"` when absent), `deprecated_at`.
  - The API omits `retired` models unless asked, so "saved model not in the list" is the normal way a retired model shows up.
- **Model cache:** `modelCache: { fetchedAt: string; models: { id; display_name; lifecycle; created_at }[] } | null` in `data.json`, fresh for 24 hours. The API key is never stored in the cache and never appears in errors, logs or URLs.
- **Loading feedback is driven only by `Progress` events** emitted by `ResearchFlow` and `PdfFlow` into an injected sink. The flows import nothing from `obsidian` and know nothing about modals, spinners or the status bar.
- **Styling:** one `styles.css` at the repo root, using Obsidian CSS variables only (`--interactive-accent`, `--text-muted`, `--text-error`, `--background-modifier-border`, …). Every animation is disabled under `@media (prefers-reduced-motion: reduce)` and replaced by static "…" text. From Task 12 on, **three files** are deployed: `main.js`, `manifest.json`, `styles.css`.
- **Startup stays silent** (Review Focus 1 above): resumed jobs never pop a modal open at startup.

## Review Focus (Tasks 12–13)

1. **Typing an API key character by character.** One fetch, 800 ms after the last keystroke. A response for an older key arriving after a newer request must be ignored. Pinned by Task 12 `debounces key changes` and `ignores a stale response`.
2. **Offline, 401, or a 429 while loading models.** The settings tab never throws; the cached list (if any) stays usable and the current model stays selected. Pinned by Task 12 `error keeps cached models`.
3. **The user closes the loading modal, then the outline arrives.** The suggestions must come back (the job cannot continue without an answer); closing the suggestion list itself still means cancel. Pinned by Task 13 Part C reducer tests and the manual check.
4. **Resumed jobs after a restart.** No modal opens for them; the status bar and explorer spinner still show activity. Pinned by Task 13 `resumed research job emits no step that opens a modal`.
5. **Explorer re-renders and many jobs at once.** The spinner class is re-applied after the explorer redraws, without a mutation loop, and cleared on finish, failure, cancel, queue-idle and unload. Pinned by Task 13 Part A tracker tests and the `navSelector` tests.

## File Structure (Tasks 12–13)

```
  styles.css                   NEW, repo root (deployed)
  src/
    models.ts                  NEW pure: ModelInfo, parse/fetch/sort/options/cache freshness, ModelCatalog, pickerView
    progress.ts                NEW pure: ProgressSink, CANCELLED_MESSAGE, OUTLINE_STAGE_MS, ProgressTracker
    types.ts                   + Progress
    research/httpAdapter.ts    + makeGet
    jobs/queue.ts              + cancelJob
    settings.ts                + modelCache, model dropdown row
    flows/researchFlow.ts      + progress events, Approver gets the job path
    flows/pdfFlow.ts           + progress events
    ui/progressModel.ts        NEW pure: modal state reducer
    ui/ResearchProgressModal.ts NEW (replaces SuggestionModal.ts; selection.ts stays)
    ui/explorerSpinner.ts      NEW: pure navSelector + DOM glue
  tests/models.test.ts, httpAdapter.test.ts (extend), settings.test.ts (extend), progress.test.ts,
        progressModel.test.ts, explorerSpinner.test.ts, queue.test.ts (extend),
        researchFlow.test.ts (extend), pdfFlow.test.ts (extend)
```

---

### Task 12: Model picker dropdown (settings)

**Files:**
- Create: `src/models.ts`, `styles.css`
- Modify: `src/research/httpAdapter.ts` (add `makeGet`), `src/settings.ts` (`PluginData.modelCache`, `mergeData`, dropdown row, `SettingsHost.catalog`), `src/main.ts` (build the catalog, pass it to the tab)
- Test: `tests/models.test.ts`; extend `tests/httpAdapter.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Consumes: `ApiError` (`src/jobs/queue.ts`), `RequestUrlFn`/`RequestUrlResult` (`src/research/httpAdapter.ts`)
- Produces:
  ```ts
  // src/research/httpAdapter.ts
  export type GetFn = (req: { url: string; method: "GET"; headers: Record<string, string> })
    => Promise<{ status: number; json: any; headers: Record<string, string> }>;
  export function makeGet(requestUrl: RequestUrlFn): GetFn;   // transport failure -> TypeError(message only), same as makeHttp
  // src/models.ts  (pure, no obsidian import)
  export interface ModelInfo { id: string; display_name: string; lifecycle: "active" | "deprecated" | "retired"; created_at: string; }
  export interface ModelCache { fetchedAt: string; models: ModelInfo[]; }
  export const MAX_PAGES = 10, CACHE_TTL_MS = 86_400_000, KEY_DEBOUNCE_MS = 800, DEFAULT_MODEL = "claude-sonnet-5-5";
  export function parseModelsPage(json: unknown): { models: ModelInfo[]; hasMore: boolean; lastId: string | null };
  export function fetchAllModels(get: GetFn, apiKey: string): Promise<ModelInfo[]>;
  export function sortModels(models: ModelInfo[]): ModelInfo[];
  export function modelOptions(models: ModelInfo[], savedId: string):
    { options: { value: string; label: string }[]; selected: string; warning?: string };
  export function isCacheFresh(cache: ModelCache | null, now: number): boolean;
  export type CatalogState = { status: "nokey" | "idle" | "loading" | "ready" | "error"; models: ModelInfo[]; error?: string };
  export interface CatalogDeps { get: GetFn; apiKey: () => string; cache: () => ModelCache | null;
    saveCache: (c: ModelCache) => Promise<void>; now: () => number;
    setTimer: (fn: () => void, ms: number) => number; clearTimer: (id: number) => void; }
  export class ModelCatalog {
    constructor(deps: CatalogDeps);
    state(): CatalogState;
    subscribe(fn: (s: CatalogState) => void): () => void;
    ensure(): void;                 // tab opened: nokey -> nokey; fresh cache -> ready (no request); else refresh()
    refresh(): Promise<void>;       // always requests (button); newest call wins
    keyChanged(): void;             // blank key -> nokey now and cancel any timer; else debounce KEY_DEBOUNCE_MS then refresh()
  }
  export interface PickerView { disabled: boolean; spinning: boolean; options: { value: string; label: string }[];
    selected: string; hint?: string; error?: string; warning?: string; }
  export function pickerView(state: CatalogState, savedId: string): PickerView;
  ```
  `PluginData` gains `modelCache: ModelCache | null` (default `null`). `SettingsHost` gains `catalog: ModelCatalog`.

- [ ] **Step 1: Write the failing tests** in `tests/models.test.ts` (fake `GetFn` that records requests and returns scripted pages; fake timers are plain injected `setTimer`/`clearTimer`; fake key `"test-key-123"`).

```ts
test("parseModelsPage maps fields, defaults lifecycle to active, skips items without an id", () => {});
test("fetchAllModels sends the exact first request", () => {
  // url === "https://api.anthropic.com/v1/models?limit=100"; headers x-api-key "test-key-123", anthropic-version "2023-06-01"
});
test("fetchAllModels follows has_more with after_id=<last_id> and merges pages without duplicate ids", () => {});
test("fetchAllModels stops after MAX_PAGES (10) even if has_more stays true", () => { /* get called exactly 10 times */ });
test("non-200 -> ApiError with the status and the API message; the key is not in the message", () => {});
test("empty key throws before any request", () => {});
test("sortModels: active first, then newest created_at first; invalid dates last", () => {});
test("modelOptions: label is display_name, ' (deprecated)' appended, retired models are not options", () => {});
test("modelOptions: saved id missing -> extra '<id> (unavailable)' option, selected stays saved, warning says to pick another", () => {});
test("modelOptions: empty saved id -> claude-sonnet-5-5 if listed, else the first active model", () => {});
test("isCacheFresh: null false; 23h true; 25h false; unparsable or future fetchedAt false", () => {});
test("ensure(): no key -> nokey and no request; fresh cache -> ready and no request; stale cache -> one request", () => {});
test("debounces key changes: 3 keyChanged() calls inside 800 ms -> one request, only after the timer fires", () => {});
test("blank key -> nokey immediately and the pending timer is cleared", () => {});
test("ignores a stale response: refresh() twice, first resolves last -> state holds the second result", () => {});
test("error keeps cached models: state.status 'error', models = cache, error message set; success saves cache with fetchedAt ISO", () => {});
test("offline TypeError gives a readable error message", () => {});
test("pickerView: nokey -> disabled + hint 'Add your API key to load models'; loading -> disabled, spinning, single option 'Loading models…'; error -> enabled, error text, current model still selected; ready with missing saved model -> warning", () => {});
```
  Extend `tests/httpAdapter.test.ts`: `makeGet` maps `{status,json,headers}`, tolerates a throwing `json`, and turns a rejected request into a `TypeError` whose message has no headers or key. Extend `tests/settings.test.ts`: `mergeData` keeps a valid `modelCache`, drops an invalid one (non-string `fetchedAt`, models missing `id`; unknown `lifecycle` values are dropped item by item), and defaults to `null`.

- [ ] **Step 2: Run the tests.** `npx vitest run tests/models.test.ts tests/httpAdapter.test.ts tests/settings.test.ts`. Expected: FAIL. Capture the red output before implementing.
- [ ] **Step 3: Implement `src/models.ts` and `makeGet`.**
  - `fetchAllModels` throws `new ApiError(message, status)`, with the message taken from `json.error.message` when present, else `HTTP <status>`. A transport `TypeError` propagates unchanged.
  - `ModelCatalog` keeps a generation counter: only the latest `refresh()` may change state or save the cache. During a refresh `models` keeps the cached list so an error can fall back to it. `saveCache` failures are ignored.
  - Error text: `ApiError` -> its message (for 401 prefix `The API key was rejected: `); `TypeError` -> `Could not reach the Anthropic API (offline?): <message>`.
  - `pickerView`: `nokey` -> `disabled: true`, `hint`; `loading` -> `disabled: true`, `spinning: true`, one option `Loading models…`; `error` -> enabled when models exist, `error` set, saved model stays selected (as an `(unavailable)` option only if absent); `ready` -> `modelOptions` and `warning`.
- [ ] **Step 4: Implement the settings row.** In `SettingsTab.display()` replace the free-text Model field with: a dropdown, a "Refresh models" extra button (class `trf-spin` on its icon while `spinning`), a hint line, a red error line (`trf-error`), a warning line.
  - Build the row once; on each catalog state change only repopulate the `<select>` and the text lines (never re-run `display()`, which would steal focus from the API key field).
  - API key `onChange` saves the key and calls `catalog.keyChanged()`. Tab open calls `catalog.ensure()`. `hide()` unsubscribes.
  - Choosing an option saves `settings.model`. When the saved model is empty and the catalog is ready, save `modelOptions(...).selected`.
  - Create `styles.css` with `.trf-error { color: var(--text-error); }`, `.trf-muted { color: var(--text-muted); }` and `.trf-spin` (a rotating icon) plus the reduced-motion override (`animation: none`).
- [ ] **Step 5: Wire `main.ts`.** `makeGet((p) => requestUrl(p) as ...)`; `new ModelCatalog({ get, apiKey: () => settings().apiKey, cache: () => this.data.modelCache, saveCache: async (c) => { this.data.modelCache = c; await this.persist(); }, now: Date.now, setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: (id) => window.clearTimeout(id) })`; pass it in the `SettingsTab` host.
- [ ] **Step 6: Run the tests.** Same command as Step 2. Expected: PASS. Then `npm test` and `npm run build` (both pass).
- [ ] **Step 7: Commit** with message `feat: model picker dropdown with cached model list`.

---

### Task 13: Loading feedback while generating folders

Implemented in four parts, each with its own red/green run and its own `feat:` commit. A reviewer gates each part.

**Files:**
- Create: `src/progress.ts`, `src/ui/progressModel.ts`, `src/ui/ResearchProgressModal.ts`, `src/ui/explorerSpinner.ts`
- Modify: `src/types.ts`, `src/jobs/queue.ts`, `src/flows/researchFlow.ts`, `src/flows/pdfFlow.ts`, `src/main.ts`, `styles.css`; delete `src/ui/SuggestionModal.ts` (importers of its `selectApproved` re-export switch to `selection.ts`)
- Test: `tests/progress.test.ts`, `tests/progressModel.test.ts`, `tests/explorerSpinner.test.ts`; extend `tests/queue.test.ts`, `tests/researchFlow.test.ts`, `tests/pdfFlow.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/types.ts
  export type Progress =
    | { kind: "step"; text: string }
    | { kind: "outline"; outline: Outline }
    | { kind: "writing"; index: number; total: number; name: string }
    | { kind: "itemDone"; name: string; ok: boolean; error?: string }
    | { kind: "done"; folders: number; notes: number }
    | { kind: "failed"; error: string };
  // src/progress.ts  (pure)
  export interface ProgressSource { kind: "research" | "pdf"; resumed: boolean; }
  export type ProgressSink = (path: string, e: Progress, src: ProgressSource) => void;
  export const CANCELLED_MESSAGE = "Cancelled";   // a cancel is reported as { kind: "failed", error: CANCELLED_MESSAGE }
  export const OUTLINE_STAGE_MS = 8000;
  export class ProgressTracker {
    handle(path: string, e: Progress, src: ProgressSource): void;  // step/outline/writing/itemDone activate the path; done/failed deactivate it
    active(): string[];
    statusSuffix(): string;           // latest text of the most recently updated active path, e.g. "Analysing paper.pdf (chunk 2/6)…"
    onChange(fn: () => void): () => void;
    clear(path?: string): void;
  }
  // src/jobs/queue.ts
  JobQueue.cancelJob(kind: Job["kind"], path: string): boolean;   // removes a queued job or flags + wakes a running one; persists; true if found
  // flows
  ResearchDeps  += { progress?: ProgressSink; later?: (fn: () => void, ms: number) => () => void }   // later() returns a cancel function
  PdfDeps       += { progress?: ProgressSink }
  Approver.approve(outline: Outline, jobPath: string): Promise<SubfolderSuggestion[] | null>
  // src/ui/progressModel.ts  (pure)
  export type ModalState = { phase: "loading" | "choose" | "writing" | "done" | "failed" | "cancelled"; topic: string; step: string;
    outline?: Outline; items: { name: string; status: "pending" | "working" | "ok" | "error"; error?: string }[];
    index: number; total: number; current: string; folders: number; notes: number; error?: string };
  export type ModalAction = Progress | { kind: "approved"; names: string[] };
  export function initialState(topic: string): ModalState;
  export function reduce(s: ModalState, a: ModalAction): ModalState;
  export function progressFraction(s: ModalState): number;   // finished items / total, 0 when total is 0
  // src/ui/explorerSpinner.ts
  export function navSelector(path: string): string;   // `.nav-folder-title[data-path="…"], .nav-file-title[data-path="…"]`, escaping \ and "
  export class ExplorerSpinner { constructor(doc: Document); set(paths: string[]): void; reattach(): void; stop(): void; }
  ```

**Event contract (what the flows emit; every test below pins one of these sequences):**
- `ResearchFlow.run`, fresh job, web search on: `step "Searching the web…"`, then (only if the outline is still pending after `OUTLINE_STAGE_MS`, scheduled with `later`) `step "Suggesting folders…"`, `outline`, then per approved subfolder `writing {index (1-based among all approved), total, name}` followed by `itemDone`, finally `done {folders: written subfolders, notes: total notes}`. Web search off: the first step is `"Suggesting folders…"` and `later` is not used.
- Resumed job (`job.approved` present): first event `step "Resuming research…"`, then `writing`/`itemDone` for the remaining subfolders only, then `done`. Its `ProgressSource.resumed` is `true`; fresh jobs send `false`.
- Every exit emits exactly one terminal event: `done`, or `failed {error}`. That covers: outline error (non-retryable), approval cancelled (`CANCELLED_MESSAGE`), `signal.cancelled` seen after the outline, after approval, before a subfolder or before the overview (`CANCELLED_MESSAGE`), missing API key, nesting too deep, "already researched". A retryable error emits `step "Retrying after a temporary error…"` and rethrows (the queue retries from the checkpoint).
- When `deps.progress` is provided the flow does not also call `notify` for these outcomes (the UI decides how to show them); without it the flow behaves exactly as before.
- `PdfFlow.run`, once the processed/in-flight check has passed: `step "Preparing paper.pdf…"`, then before each API call `step "Analysing paper.pdf (chunk 2/6)…"`, then `done {folders: distinct subfolders written, notes}`. Every exit after the first step emits `failed {error}` (with `CANCELLED_MESSAGE` for a cancel); a retryable error emits `step "Retrying paper.pdf after a temporary error…"` and rethrows. The existing `notify` calls stay.

#### Part A: types, queue cancel, tracker

- [ ] **Step 1: Write the failing tests.**

```ts
// tests/queue.test.ts
test("cancelJob removes a queued job and persists without it; returns true", async () => {});
test("cancelJob flags a running job, wakes a sleeping retry, and the job is not retried or persisted", async () => {});
test("cancelJob returns false for an unknown job", async () => {});
// tests/progress.test.ts
test("tracker activates a path on a step and deactivates it on done", () => {});
test("tracker deactivates on failed, including CANCELLED_MESSAGE", () => {});
test("statusSuffix is the latest step text of the most recently updated active path; empty when none", () => {});
test("writing events render as 'Writing folder 2 of 5: Anatomy'", () => {});
test("clear(path) and clear() remove paths and notify subscribers once", () => {});
```
- [ ] **Step 2: Run the tests** (`npx vitest run tests/queue.test.ts tests/progress.test.ts`). Expected: FAIL; capture the red output.
- [ ] **Step 3: Implement** `Progress` in `src/types.ts`, `src/progress.ts`, `JobQueue.cancelJob`.
- [ ] **Step 4: Run the tests.** Expected: PASS; then `npm test` and `npm run build`.
- [ ] **Step 5: Commit** with message `feat: progress events, tracker and per-job cancel`.

#### Part B: flows emit progress

- [ ] **Step 1: Write the failing tests** (fake sink collecting `[path, event, source]`; fake `later` that stores the callback and returns a cancel spy; reuse the existing fakes).

```ts
// tests/researchFlow.test.ts
test("successful run emits step, step, outline, writing/itemDone per subfolder, then done with folder and note counts", () => {});
test("the second step only fires if the outline is still pending, and its timer is cancelled when the outline arrives", () => {});
test("web search off: first step is 'Suggesting folders…' and later() is not used", () => {});
test("failed outline (non-retryable) emits failed with the message and does not throw or notify", () => {});
test("retryable outline error emits the retry step and rethrows", () => {});
test("one failing subfolder emits itemDone ok:false with the reason, the rest continue, done counts only successes", () => {});
test("approval cancelled emits failed CANCELLED_MESSAGE", () => {});
test("cancel after the outline returns (user pressed Cancel) writes nothing and emits failed CANCELLED_MESSAGE", () => {});
test("cancel mid-way stops at the next subfolder and emits failed CANCELLED_MESSAGE", () => {});
test("resumed research job emits no step that opens a modal: source.resumed true, first event 'Resuming research…'", () => {});
test("approver receives the job path as its second argument", () => {});
test("without a sink the flow still notifies as before", () => {});
// tests/pdfFlow.test.ts
test("3-chunk pdf emits 'Preparing…', chunk 1/3, 2/3, 3/3 steps then done with folder and note counts", () => {});
test("encrypted pdf emits failed after the preparing step; cancelled pdf emits failed CANCELLED_MESSAGE", () => {});
test("already processed pdf emits nothing", () => {});
test("retryable chunk error emits the retry step and rethrows", () => {});
```
- [ ] **Step 2: Run the tests** (`npx vitest run tests/researchFlow.test.ts tests/pdfFlow.test.ts`). Expected: the new tests FAIL, the old ones still pass; capture the red output.
- [ ] **Step 3: Implement** the emissions per the event contract. Keep one private `finish(path, event)` helper per flow so terminal events cannot be forgotten, and add the `signal.cancelled` checks after the outline and after approval.
- [ ] **Step 4: Run the tests.** Expected: PASS; then `npm test` and `npm run build`.
- [ ] **Step 5: Commit** with message `feat: research and PDF flows emit progress events`.

#### Part C: the progress modal

- [ ] **Step 1: Write the failing tests** (`tests/progressModel.test.ts`).

```ts
test("initial state is loading with the topic and no items", () => {});
test("step updates the step line while loading", () => {});
test("outline moves loading -> choose and keeps the outline", () => {});
test("approved moves choose -> writing with one pending item per name", () => {});
test("writing marks the current item working and sets index, total and current name", () => {});
test("itemDone marks ok or error (with reason)", () => {});
test("done -> phase done with folders and notes (view text 'Done — 5 folders, 15 notes')", () => {});
test("failed -> phase failed with the error; failed with CANCELLED_MESSAGE -> phase cancelled", () => {});
test("progressFraction counts finished items over total and never exceeds 1", () => {});
test("an outline arriving after the user closed the loading modal is still reduced (state is independent of visibility)", () => {});
```
- [ ] **Step 2: Run the tests.** Expected: FAIL; capture the red output.
- [ ] **Step 3: Implement** `src/ui/progressModel.ts`, then `ResearchProgressModal` (replaces `SuggestionModal`, same `selectApproved` for names):
  - Renders by phase. Loading: CSS spinner (`trf-spinner`), title `Researching <topic>…`, the step line, a **Cancel** button (`onCancel()` then close). Choose: the existing summary, checkbox list, editable names, `why` text, **Create** (disabled when none checked) and **Cancel**. Writing: progress bar (`trf-progress`, width from `progressFraction`), the line `Writing folder 2 of 5: Anatomy`, a list with `✓` / `✗ <reason>`. Done: `Done — N folders, M notes` and **Close**. Failed: the error with **Retry** (`onRetry()`) and **Close**. Cancelled: closes itself.
  - Close behaviour: loading -> hides, the job keeps running, and `approve()` reopens the modal when the outline arrives; choose -> resolves `null` (cancel); writing/done/failed -> just closes.
  - `approve(outline, jobPath)` resolves exactly once; it resolves `null` if the modal is closed in the choose phase or the plugin unloads.
  - Append `.trf-spinner`, `.trf-progress`, `.trf-progress > div` to `styles.css` with `--interactive-accent` and `--background-modifier-border`; reduced-motion shows static text instead of rotating.
- [ ] **Step 4: Run the tests.** Expected: PASS; then `npm test` and `npm run build`.
- [ ] **Step 5: Commit** with message `feat: research progress modal with loading, progress and error states`.

#### Part D: explorer spinner, status bar and wiring

- [ ] **Step 1: Write the failing tests** (`tests/explorerSpinner.test.ts`).

```ts
test("navSelector targets folder and file nav titles by data-path", () => {
  expect(navSelector("Black holes")).toBe('.nav-folder-title[data-path="Black holes"], .nav-file-title[data-path="Black holes"]');
});
test("navSelector escapes quotes and backslashes", () => {});
```
- [ ] **Step 2: Run the tests.** Expected: FAIL; capture the red output.
- [ ] **Step 3: Implement** `ExplorerSpinner`: `set(paths)` adds/removes the class `trf-working` on matching nav items (missing elements are skipped silently); a `MutationObserver` with `{ childList: true, subtree: true }` (no attribute observation, so adding the class cannot retrigger it) on each `[data-type="file-explorer"]` container re-applies the class, throttled with `requestAnimationFrame`; `reattach()` re-finds the containers (called on workspace `layout-change`); `stop()` disconnects and removes every class. CSS: `.trf-working::after` is a small ring using `var(--interactive-accent)`; reduced-motion shows a static `…`.
- [ ] **Step 4: Wire `main.ts`.**
  - One `ProgressTracker`; its change callback updates the status bar to `Research: r/q` plus ` · <statusSuffix()>` when non-empty (hidden only when `r+q = 0` and the suffix is empty) and calls `spinner.set(tracker.active())`.
  - The sink passed to both flows calls `tracker.handle(...)` first. For `source.kind === "research"`: a `step` for a path with no session and `resumed === false` creates and opens a `ResearchProgressModal` (wired so Cancel calls `queue.cancelJob("research", path)` and Retry calls `researchFlow.researchFolder(path)`); later events go to that session's `reduce`. The `Approver` looks up the session by `jobPath`. When a research `failed`, `done` or `itemDone ok:false` event arrives and no modal is open for that path, show a Notice (`Researched <topic>: N folders, M notes`, or the error). PDF jobs never open a modal.
  - Safety nets: `queue` `onChange` with `r + q === 0` calls `tracker.clear()`; `onFailed` sends `failed` for the job's path; "Cancel all research jobs" calls `tracker.clear()` and fails any open modals with `CANCELLED_MESSAGE`; `workspace.on("layout-change")` calls `spinner.reattach()`; `onunload` calls `spinner.stop()`, `tracker.clear()` and closes the modals.
  - `later: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); }`.
- [ ] **Step 5: Verify.** `npm test` (all pass) and `npm run build` (no errors).
- [ ] **Step 6: Manual check in a test vault.** Copy `main.js`, `manifest.json` **and `styles.css`** into the plugin folder, reload the plugin, then:
  1. Settings -> the Model row: with no key it is disabled with the hint; with a valid key it loads real models, active ones first; "Refresh models" shows a spinner; a wrong key shows a red error and keeps the previous list; offline (turn Wi-Fi off, press Refresh) shows a red error and keeps the list; pick a model, reopen settings, it is still selected; typing a key shows a single request ~0.8 s after you stop.
  2. Create `Black holes+`: the modal appears instantly with the spinner, "Researching Black holes…" and the step line; the folder shows a spinner in the file explorer; the suggestion list replaces the loading view; Cancel in the loading state closes it and the spinner disappears.
  3. After Create: progress bar and "Writing folder 2 of 5: …" with ticks; close the modal early, the status bar keeps counting and the explorer spinner stays; the notes still land; at the end a Notice says how many folders and notes (the modal, if left open, shows "Done — N folders, M notes").
  4. Force an error (use a bad key): the modal shows the message with Retry and Close.
  5. Drop a PDF into a researched folder: the status bar shows "Analysing paper.pdf (chunk 1/N)…" and the PDF shows an explorer spinner until it finishes.
  6. Collapse and expand the folder while it works: the spinner returns. Restart Obsidian mid-job: no modal opens; the status bar and spinner resume.
  7. Turn on your OS "reduce motion" setting: spinners are replaced by static "…".
- [ ] **Step 7: Commit** with message `feat: explorer spinner, status bar progress and modal wiring`.

---

# Addendum 2: Tasks 14–19 (non-blocking loading, PDF triggers, two-stage PDF research, follow-up fixes)

> Tasks 1–13 are implemented. These tasks change behaviour that earlier tasks introduced; the "Supersedes" list below says exactly what is replaced. Same rules as before: test-first (capture the red run before implementing; a test that already passes proves nothing), `npm test` and `npm run build` both pass before an item is done, no real API key anywhere, fake HTTP only. **Each numbered item (1–17) is its own commit** with a `feat:`/`fix:`/`refactor:` message. Item numbers below are the user's numbering.

## Supersedes

- **Task 13 UI:** the loading modal and the progress modal (phases loading/writing/done/failed/cancelled of `ResearchProgressModal`, `session` wiring, `shouldOpenSession`, `restoredPaths`) are removed. The suggestion list becomes a plain `SuggestionModal` again (choose phase only).
- **Task 9:** `ResearchFlow.run` no longer awaits an `Approver` inside the queue slot. It stores the outline as a *pending review* and finishes. `Approver`, `deps.approver`, `listPdfs`, `queuePdfs` are removed from `ResearchDeps`; the research flow no longer enqueues PDFs.
- **Task 10:** automatic PDF processing, the 2-second multi-drop batching, `queuePaths`, `forget`, `setTimer` and the "Analyse PDFs in this folder" command are removed. `PdfFlow` is rewritten around the suffix trigger and the two-stage run. `extractPdf`, `pdfPrompt`, `parsePdfExtraction`, `PdfExtraction`, `ExtractedNote`, `VaultWriter.writeExtracted` and `mergeExtractions` are deleted in item 10 (dead code).
- **Task 11:** the status bar item becomes clickable; `main.ts` keeps only adapters and registration (the Notice/spinner/failure wiring moves to `src/ui/hub.ts`).
- **Task 12:** model choice gains an "explicitly chosen" flag and capability-based disabling.

## Decisions (made where the requests conflict or are silent; each is cheap to reverse)

1. **Pending suggestions are not held in a queue slot.** If the research job waited for the user inside `run`, two unreviewed topics would occupy both `maxConcurrent` slots and block every other job. Instead the outline job *finishes* after storing `{ path, outline }` in `PluginData.pendingReviews` (persisted, so it survives a restart). Review (Notice button or command) opens the suggestion modal; **Create** enqueues a normal research job `{ approved }`; closing the modal without Create deletes the pending review and counts as a cancel.
2. **Inside a research root, a PDF's key points go to the matching existing subfolder** (case-insensitive name match from the model's `subfolder`), else to `From PDFs/<key point name>/` (as before); its overview goes to `Sources/<pdf name> - Overview.md` without the research-root marker. **Outside a root**, `<pdf dir>/<pdf name>/` is created and holds `<pdf name> - Overview.md` **with** `research-root: true` (the folder becomes a normal research root) plus one subfolder per key point.
3. **Linking to a subfolder:** wikilinks cannot target folders, so Stage 1 also writes an *entry note* `<Key point name>.md` (normal template, built from what the PDF says) into each key point's folder, and the overview links `[[<folder>/<Key point name>|<Key point name>]]`. The links therefore resolve before Stage 2 has produced anything.
4. **Large-PDF confirm stays a (small) modal** (`ConfirmModal`) because item 9 requires it; it is the one exception to "the suggestion modal is the only modal" and appears only for a single PDF over `confirmAbovePages`.
5. **Model capability disabling:** a model whose `capabilities.pdf_input.supported === false` is always disabled with "(no PDF support)"; one whose `capabilities.server_tools.web_search.supported === false` is disabled with "(no web search)" **only while "Use web search" is on**. `capabilities` null or missing fields never disable anything.
6. **Item 14's "stale restart marker"** disappears with the removal of `restoredPaths`; the regression tests are written against the new pending-review/restore flow (cancelling a restored pending review or job leaves no stale state).

## Global Constraints (Tasks 14–19)

- **Nothing blocks the user while work runs.** The only loading indicators are: a small spinning circle next to the item's name in the file explorer (the topic folder while it is researched or awaiting review; a PDF file while it is analysed; a key-point folder while it is researched), and status bar text. No modal opens by itself except the user-confirmed ones: `SuggestionModal` (opened from Review) and the large-PDF `ConfirmModal`.
- **Spinner:** CSS class `trf-working` on `.nav-folder-title[data-path]` / `.nav-file-title[data-path]`; re-applied after explorer re-renders (MutationObserver, childList+subtree only); removed on finish, failure, cancel, queue idle, unload. `prefers-reduced-motion: reduce` shows a static dot (`•`) instead of rotating.
- **Status bar:** text like `Researching Black holes…`, `Analysing paper.pdf (chunk 2/6)…`; hidden when idle; clicking it opens a menu with **Cancel all research jobs** (and **Review pending suggestions** when any exist).
- **PDF trigger:** a PDF is processed only when its name ends with the trigger suffix: `paper+.pdf` (main form) or `paper.pdf+`. Case-insensitive `.pdf`. A bare `+.pdf` / `.pdf+` is not a trigger. After triggering, the file is renamed to `paper.pdf` (collision-safe: `paper (2).pdf`) when `stripSuffix` is on. Explicit triggers always run regardless of `processedPdfs`; the hash is only used to skip a *restored* pdf job that already finished before a restart.
- **PDF overview:** exactly 5 key points, or fewer when the document genuinely has fewer distinct ideas; never padded; each ends with `(p. N)`; chunked PDFs merge chunk results and a text-only model call picks the top 5 overall; each key point has a name of at most 5 words.
- **Key point research:** one queued job per key point (kind `keypoint`), `notesPerSubfolder` notes each in the normal note template, web search when `useWebSearch` is on, context = PDF title + key point + what the PDF says about it; no approval modal; one failure never stops the others.
- **Notices:** neutral (not error-styled) for a user cancel (`Cancelled`) and for re-triggering a researched folder (`Already researched — use 'Research this folder' to run it again`). "Research this folder" (command and context menu) forces a re-run of an already researched folder.
- **Status text** never mentions the web when `useWebSearch` is off.
- **Model default:** `claude-sonnet-5-5`; an `(unavailable)` option plus warning appears only if the user explicitly chose that model; if nothing was chosen and the default is not listed, silently use the first active model.
- Deployed files: `main.js`, `manifest.json`, `styles.css` (documented in `README.md`).

## Review Focus (Tasks 14–19)

1. **Two unreviewed topics must not block PDFs or other research.** Pinned by Task 16 `outline job finishes and frees its slot`.
2. **A restart with a pending review.** Spinner and a "Suggestions ready" Notice return; no modal opens by itself; the outline is not re-requested (no second API charge). Pinned by Task 16 `restored pending review`.
3. **Renaming a PDF to `paper+.pdf` fires create/rename events for the rename back.** No retrigger, no loop; `paper (2).pdf` on collision. Pinned by Task 17 tests.
4. **A 400-page PDF with 5 key points and 5 web-searched jobs on a 429 storm.** Stage 1 retries without re-sending finished chunks; a failing key-point job does not stop the others; the queue still honours `maxConcurrent`. Pinned by Task 18 tests.
5. **The same notice twice** (flow failed, then queue gave up) shows once. Pinned by Task 15 hub tests.

## File Structure (Tasks 14–19)

```
  README.md                    NEW (item 17)
  src/
    ui/hub.ts                  NEW pure: ProgressHub (Notices, spinner set, status text, pending reviews, run ids, dedupe)
    progress.ts                RunGate/ProgressTracker/noticeFor move behind the hub; + neutral messages; ProgressSource.kind adds "keypoint"
    types.ts                   Job adds "keypoint" + research.force + pdf.resume; KeyPoint, PdfOverview; removes PdfExtraction/ExtractedNote (item 10)
    pdf/trigger.ts             NEW pure: pdfTriggerName
    flows/researchFlow.ts      outline job stores a pending review and finishes; "force"; no Approver, no PDF enqueue
    flows/pdfFlow.ts           rewritten: suffix trigger, rename, per-PDF confirm, Stage 1
    flows/keypointFlow.ts      NEW: Stage 2 job runner
    research/prompts.ts        + pdfOverviewPrompt, mergeOverviewsPrompt; - pdfPrompt (item 10)
    research/parse.ts          + parsePdfOverview, parseMergedOverview; - parsePdfExtraction (item 10)
    research/claudeClient.ts   ResearchClient: + overviewPdf, mergeOverviews; - extractPdf
    vault/writer.ts            + writePdfOverview, + containerFor; - writeExtracted (item 10)
    vault/noteTemplate.ts      + renderPdfOverview
    models.ts / settings.ts    modelChosen flag, capability flags, PluginData.pendingReviews
    ui/SuggestionModal.ts      back, choose-phase only (ResearchProgressModal.ts and progressModel.ts deleted)
```

---

### Task 14: Small fixes (items 11, 12, 13)

**Files:** Modify `src/models.ts`, `src/settings.ts`, `src/flows/researchFlow.ts`, `src/progress.ts`, `src/main.ts`; tests: extend `tests/models.test.ts`, `tests/settings.test.ts`, `tests/researchFlow.test.ts`, `tests/progress.test.ts`.

**Interfaces:**
- `Settings` gains `modelChosen: boolean` (default `false`). `mergeData`: a saved `model` that differs from the default and has no `modelChosen` is treated as chosen (`true`); a missing/non-boolean flag otherwise defaults to `false`. The Task 11 `defaults` test is updated to include the field.
- `modelOptions(models: ModelInfo[], savedId: string, chosen: boolean)` and `pickerView(state: CatalogState, savedId: string, chosen: boolean)`: when `chosen` is false and `savedId` is not an active listed model, `selected` is `claude-sonnet-5-5` if listed, else the first active model, with **no** warning and no `(unavailable)` option; when `chosen` is true the Task 12 behaviour is unchanged. The settings tab saves an automatic selection into `settings.model` without setting `modelChosen`; picking from the dropdown sets `modelChosen = true`.
- `src/progress.ts`: `export const ALREADY_RESEARCHED_MESSAGE = "Already researched — use 'Research this folder' to run it again"`; `export function isNeutralMessage(msg: string): boolean` (true for `CANCELLED_MESSAGE` and `ALREADY_RESEARCHED_MESSAGE`); `noticeFor` returns `{ text: string; error: boolean }` where neutral messages give `error: false` and a user cancel now yields the Notice text `Cancelled` (previously `null`).
- `ResearchFlow.researchFolder(path: string, opts?: { force?: boolean }): Promise<void>`; the research `Job` gains `force?: boolean`; a fresh job with `force` skips the "already researched" check. "Research this folder" (command and folder menu) passes `{ force: true }`; the `Topic+` trigger does not.

- [ ] **Item 11, Step 1: write the failing tests.**
```ts
test("modelOptions: not chosen and default missing -> first active model, no warning, no unavailable option", () => {});
test("modelOptions: chosen and missing -> '<id> (unavailable)' option and a warning (unchanged)", () => {});
test("modelOptions: not chosen and default listed -> default selected", () => {});
test("mergeData: model other than the default without the flag -> modelChosen true; no model -> false", () => {});
test("pickerView passes the chosen flag through", () => {});
```
- [ ] **Step 2:** run `npx vitest run tests/models.test.ts tests/settings.test.ts` — expected FAIL (capture it). **Step 3:** implement the flag, `modelOptions`/`pickerView` change, dropdown `onChange` sets `modelChosen`, automatic selection saved without it. **Step 4:** tests pass, `npm test` and `npm run build`. **Step 5: Commit** `fix: only warn about an unavailable model the user chose`.
- [ ] **Item 12, Step 1: write the failing tests** in `tests/researchFlow.test.ts`.
```ts
test("web search off: no emitted step text mentions the web or searching; first step is 'Researching <topic>…'", () => {});
test("web search on: steps include 'Searching the web…' (once, before the staged 'Suggesting folders…')", () => {});
```
  **Step 2–4:** red run, make the flow (and any status copy) emit web-search wording only when `settings().useWebSearch`, green. **Step 5: Commit** `fix: mention web search only when it is on`.
- [ ] **Item 13, Step 1: write the failing tests.**
```ts
test("isNeutralMessage: Cancelled and Already researched are neutral, other text is not", () => {});
test("noticeFor: failed Cancelled -> { text: 'Cancelled', error: false }", () => {});
test("noticeFor: failed ALREADY_RESEARCHED_MESSAGE -> neutral text, error false", () => {});
test("researchFlow: fresh job on a researched folder emits failed ALREADY_RESEARCHED_MESSAGE; with force it proceeds to the outline", () => {});
test("researchFolder(path, {force:true}) enqueues a job with force; onFolderEvent never forces", () => {});
```
  **Step 2–4:** red, implement (the flow uses `ALREADY_RESEARCHED_MESSAGE`; wire `force` through `researchFolder`, the job, the command and menu in `main.ts`), green. **Step 5: Commit** `fix: neutral notices for cancel and already-researched, and a forced re-run`.

---

### Task 15: Testable hub (item 15)

**Files:** Create `src/ui/hub.ts`, `tests/hub.test.ts`. Modify `src/progress.ts` (RunGate/tracker/noticeFor stay there and are used by the hub). `main.ts` is wired to the hub in Task 16; this task adds the hub and its tests only.

**Interfaces:** `hub.ts` is pure (no `obsidian` import).
```ts
export interface PendingReview { path: string; outline: Outline; }
export interface HubUi {
  notice(text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }): void;
  setStatus(text: string): void;                 // "" hides the item
  setSpinners(paths: string[]): void;
  reviewModal(outline: Outline): Promise<SubfolderSuggestion[] | null>;   // resolves null when closed without Create
}
export interface HubActions {
  startApproved(path: string, approved: SubfolderSuggestion[]): void;      // enqueue the research job with `approved`
  cancelJob(kind: Job["kind"], path: string): boolean;
  retry(path: string): void;
  persistPending(list: PendingReview[]): void;
}
export class ProgressHub {
  constructor(ui: HubUi, actions: HubActions);
  readonly sink: ProgressSink;                   // (path, event, src) from the flows
  onQueueChange(running: number, queued: number): void;      // clears everything when 0/0 and nothing pending
  onQueueFailed(job: Job, err: unknown): void;               // deduped against a flow-sent failure for the same run
  restorePending(list: PendingReview[], jobs: Job[]): void;  // after restart: spinner + one "Suggestions ready" notice each, no modal
  pending(): PendingReview[];
  review(path?: string): void;                   // Notice button / command: opens the modal for `path` or the oldest pending one
  cancelAll(): void;                             // clears pending, spinners, status
  dispose(): void;                               // ignores everything afterwards
}
```
Behaviour: wraps `ProgressTracker`, `RunGate` and `noticeFor` (run-id dedupe as implemented in Task 13). An `outline` event for a research source records a pending review, calls `persistPending`, keeps the spinner on and shows `Suggestions ready for <topic>` with a **Review** action. `review()` awaits `ui.reviewModal`; a result starts the approved job (`actions.startApproved`) and removes the pending review; `null` removes it, clears the spinner and shows the neutral `Cancelled` notice.

- [ ] **Step 1: Write the failing tests** (`tests/hub.test.ts`, fake `HubUi` recording calls, fake `HubActions`).
```ts
test("folder research success: spinner on first step, status text, done notice, spinner cleared", () => {});
test("outline failure: failed event -> one error notice, spinner cleared, no pending review", () => {});
test("user cancel via the review modal (null): neutral 'Cancelled' notice, spinner cleared, pending removed and persisted", () => {});
test("suggestions ready, then reviewed later: notice with Review action, spinner stays, review() starts the approved job", () => {});
test("resumed job awaiting review: restorePending shows the notice and spinner, opens no modal, does not call retry or enqueue", () => {});
test("queue failure after flow failure shows one notice only", () => {});
test("PDF two-stage run: pdf steps + done -> overview notice; keypoint steps spin the key point folder; a failed keypoint -> one error notice; others unaffected", () => {});
test("onQueueChange(0,0) clears spinners and status but keeps spinners of pending reviews", () => {});
test("cancelAll clears pending reviews, spinners and status and persists the empty list", () => {});
test("dispose ignores later events", () => {});
```
- [ ] **Step 2:** `npx vitest run tests/hub.test.ts` — expected FAIL (capture it). **Step 3:** implement `ProgressHub` using the existing `ProgressTracker`, `RunGate`, `noticeFor`, `nextRunId` (move shared helpers if needed; keep their tests green). The PDF/keypoint events use `ProgressSource.kind` `"pdf"` / `"keypoint"` (added to the union here; the flows start emitting `"keypoint"` in Task 18). **Step 4:** pass; `npm test`, `npm run build`. **Step 5: Commit** `refactor: add a testable progress hub`.

---

### Task 16: Non-blocking loading (items 4, 5, 1, 2, 3, 14)

**Files:** Modify `src/flows/researchFlow.ts`, `src/types.ts`, `src/settings.ts` (`PluginData.pendingReviews`, `mergeData`), `src/main.ts`, `src/ui/SuggestionModal.ts` (recreated), `src/ui/explorerSpinner.ts`, `styles.css`; delete `src/ui/ResearchProgressModal.ts`, `src/ui/progressModel.ts` and their tests. Tests: extend `tests/researchFlow.test.ts`, `tests/hub.test.ts`, `tests/settings.test.ts`.

**Interfaces:** `PluginData.pendingReviews: PendingReview[]` (default `[]`, validated item by item in `mergeData`). `ResearchFlow.run` after a successful outline: emits `outline`, then **returns** (no `Approver`; job completes, slot freed). A job with `approved` runs the writing stages as before.

- [ ] **Item 4 + 5, Step 1: write the failing tests.**
```ts
test("outline job emits step(s) then outline and finishes without writing anything or awaiting the user", () => {});
test("outline job frees its queue slot: with maxConcurrent 1, a second queued job runs while the first awaits review", () => {});
test("hub: Create enqueues a research job with approved; a second review of the same path is a no-op", () => {});
test("hub: closing the suggestion modal without Create cancels the job: pending removed, spinner cleared, neutral notice", () => {});
test("settings: pendingReviews survive mergeData; invalid entries are dropped", () => {});
test("restored pending review (hub.restorePending): notice with Review, spinner on, outline not requested again", () => {});
test("'Review pending suggestions' with nothing pending shows a neutral notice", () => {});
```
  **Step 2:** red run. **Step 3:** flow change, `pendingReviews` persistence (`persistPending` saves `data.json`), wire `main.ts` to `ProgressHub`: the sink and queue callbacks go to the hub, `HubUi.reviewModal` opens `SuggestionModal`, `HubUi.notice` builds a Notice with a **Review** button (`DocumentFragment` with a `button`), command **Review pending suggestions** (`id: review-pending-suggestions`), `onLayoutReady` calls `hub.restorePending(data.pendingReviews, resumedJobs)`. **Step 4:** green. **Step 5: Commit** `feat: review folder suggestions on demand instead of in a blocking modal` (item 4) — then a second commit `feat: closing the suggestion modal cancels the job` if the cancel path is separate (item 5).
- [ ] **Item 1, Step 1: write the failing tests.**
```ts
test("no session or modal object is created for any progress event (hub opens nothing except through review())", () => {});
test("loading, progress and error events produce only status/spinner/notice calls", () => {});
```
  **Step 2–4:** delete the loading/progress modal files and `session`/`restoredPaths`/`shouldOpenSession` code and their tests, keep `selectApproved`. **Step 5: Commit** `refactor: remove the loading and progress modals`.
- [ ] **Item 2, Step 1: write the failing tests** (`tests/explorerSpinner.test.ts`, `tests/hub.test.ts`).
```ts
test("spinner paths: the topic folder while researching and while awaiting review; the pdf file while analysing; removed on done, failed, cancelled", () => {});
test("navSelector unchanged; spinnerClassFor('•' reduced motion) is documented in CSS (css text contains a prefers-reduced-motion block with content: '•')", () => {});
```
  **Step 2–4:** CSS: `.trf-working::after` ring rotates; under `prefers-reduced-motion: reduce` it is a static dot (`content: "•"`, no border, no animation). **Step 5: Commit** `feat: file explorer spinner for folders and PDFs with a static dot for reduced motion`.
- [ ] **Item 3, Step 1: write the failing tests** (`tests/hub.test.ts`).
```ts
test("status text: 'Researching Black holes…' during research, 'Analysing paper.pdf (chunk 2/6)…' during a pdf run, empty when idle", () => {});
test("status shows the latest step of the most recently updated active path", () => {});
test("hub exposes menuItems(): Cancel all research jobs always when work exists; Review pending suggestions when pending", () => {});
```
  **Step 2–4:** `main.ts`: `statusEl` registers a click handler that opens an Obsidian `Menu` built from `hub.menuItems()`; status text comes from `HubUi.setStatus`. **Step 5: Commit** `feat: clickable status bar with cancel and review actions`.
- [ ] **Item 14, Step 1: write the failing regression tests** (`tests/hub.test.ts`, `tests/researchFlow.test.ts`).
```ts
test("cancelling a restored pending review clears its spinner and persisted entry; re-triggering the same folder then behaves like a fresh run", () => {});
test("cancelling a restored research job (Cancel all) leaves no stale state: the next trigger on that path is accepted and shows its notices", () => {});
```
  **Step 2–4:** fix whatever state survives. **Step 5: Commit** `fix: cancelling a restored job clears its state`.
- [ ] **Step 6: Verify.** `npm test` and `npm run build`.

---

### Task 17: PDF trigger on the PDF itself (items 6, 7, 8, 9)

**Files:** Create `src/pdf/trigger.ts`; modify `src/flows/pdfFlow.ts`, `src/flows/researchFlow.ts`, `src/types.ts` (`Job` pdf gets `resume?: boolean`), `src/main.ts`; tests `tests/pdfTrigger.test.ts`, extend `tests/pdfFlow.test.ts`, `tests/researchFlow.test.ts`.

**Interfaces:**
```ts
// src/pdf/trigger.ts (pure)
export function pdfTriggerName(fileName: string, suffix: string): { clean: string } | null;
// "paper+.pdf" -> { clean: "paper.pdf" }; "paper.pdf+" -> { clean: "paper.pdf" }; "paper.pdf" -> null; "+.pdf" -> null; "notes+.PDF" -> { clean: "notes.PDF" }; "a.txt+" -> null
export function containerFor(pdfPath: string, root: { root: string } | null): { container: string; asRoot: boolean };
// no root -> { container: "<dir>/<stem>" (collision-safe at creation), asRoot: true }; inside a root -> { container: root.root, asRoot: false } (overview goes to <root>/Sources)
// PdfFlow
PdfDeps: { client, writer, notify, confirm, readBinary, settings, today, enqueue, processed, markProcessed, rename, progress? }   // setTimer and forget removed
PdfFlow.onFileEvent(path: string): Promise<void>     // any file; only trigger names do anything
PdfFlow.run: Runner
```
Main registers every non-folder `create`/`rename` for `pdfFlow.onFileEvent` (gated by `processPdfs`).

- [ ] **Item 6, Step 1: write the failing tests.**
```ts
test("research flow finishing does not enqueue or queue any pdf (no listPdfs/queuePdfs in deps)", () => {});
test("a pdf created inside a research root without the suffix is ignored", () => {});
```
  **Step 2–4:** remove `listPdfs`/`queuePdfs` from `ResearchDeps` and wiring; stop treating plain PDFs as work. **Step 5: Commit** `feat: stop processing every PDF in a research folder`.
- [ ] **Item 7, Step 1: write the failing tests.**
```ts
test("pdfTriggerName table above, plus multi-character suffix and trailing spaces ('paper +.pdf' is a trigger, clean 'paper .pdf' trimmed to 'paper.pdf')", () => {});
test("onFileEvent: ignores events before ready; ignores non-triggers; for paper+.pdf renames to paper.pdf and enqueues a pdf job for the clean path", () => {});
test("accepts paper.pdf+ too", () => {});
test("stripSuffix off: no rename, job for the original path", () => {});
test("rename collision -> 'paper (2).pdf'", () => {});
test("the rename back to paper.pdf does not retrigger (no suffix) and consumeCreated-style double events enqueue once (dedupe by kind+path)", () => {});
test("an unreadable or missing file at trigger time is skipped silently", () => {});
```
  **Step 2–4:** implement `pdfTriggerName` (apply `isTriggerName` logic to the stem for the `+.pdf` form; to the whole name for the `.pdf+` form), rewrite `onFileEvent`; remove the batching timer, `pendingHashes`, `queuePaths`, `forget`. **Step 5: Commit** `feat: trigger PDF analysis with the suffix on the PDF name`.
- [ ] **Item 8, Step 1: write the failing tests.**
```ts
test("containerFor: pdf outside any root -> '<dir>/<stem>'; inside a root -> the root (overview in <root>/Sources)", () => {});
test("run outside a root creates '<dir>/<stem>' (collision-safe) and marks the overview as research-root", () => {});
test("run inside a root writes the overview under Sources without the research-root marker", () => {});
```
  **Step 2–4:** `findResearchRoot(pdfPath)` decides the case; the writer creates the container with `uniqueName`. **Step 5: Commit** `feat: put PDF output next to the PDF or into the research root`.
- [ ] **Item 9, Step 1: write the failing tests.**
```ts
test("explicit trigger runs even if the hash is in processedPdfs", () => {});
test("a restored pdf job (resume: true) whose hash is already processed is skipped", () => {});
test("a single pdf over confirmAbovePages asks once; declined enqueues nothing but the file is still renamed back; under the limit never asks", () => {});
test("two PDFs triggered back to back are not batched: each is handled on its own (no timer dependency)", () => {});
```
  **Step 2–4:** implement; `main.ts` marks restored pdf jobs `resume: true`; `markProcessed` after Stage 1 completes. **Step 5: Commit** `feat: always run explicit PDF triggers and confirm large PDFs one by one`.
- [ ] **Step 6: Verify.** `npm test` and `npm run build`.

---

### Task 18: Two-stage PDF research (item 10)

**Files:** Create `src/flows/keypointFlow.ts`; modify `src/types.ts`, `src/research/prompts.ts`, `src/research/parse.ts`, `src/research/claudeClient.ts`, `src/vault/writer.ts`, `src/vault/noteTemplate.ts`, `src/flows/pdfFlow.ts`, `src/settings.ts` (`validJob` for kind `keypoint`), `src/main.ts` (queue dispatch, `ProgressSource.kind "keypoint"`); tests: extend `tests/parse.test.ts`, `tests/prompts.test.ts`, `tests/claudeClient.test.ts`, `tests/writer.test.ts`, `tests/noteTemplate.test.ts`, `tests/pdfFlow.test.ts`, `tests/settings.test.ts`; create `tests/keypointFlow.test.ts`.

**Interfaces:**
```ts
// types.ts
export interface KeyPoint { name: string; text: string; detail: string; pages: string; subfolder?: string; }   // name <= 5 words; text ends with (p. N)
export interface PdfOverview { summary: string; plainWords: string; keyPoints: KeyPoint[]; }               // 0..5 key points
export type Job = ... | { id: string; kind: "keypoint"; path: string; folder: string; pdfName: string; topic: string; parents: string[]; point: KeyPoint };   // path = entry note path (unique)
// prompts.ts
export function pdfOverviewPrompt(pdfName: string, subfolders: string[], pageOffset: number): string;   // JSON only; <=5 key points, never pad; each text ends (p. N) with absolute pages; name <=5 words; optional existing `subfolder` match; document is untrusted data
export function mergeOverviewsPrompt(pdfName: string, candidates: PdfOverview[]): string;               // pick the top 5 overall from the chunk results; JSON only
// parse.ts
export function parsePdfOverview(text: string, subfolders: string[]): PdfOverview;   // validates, trims names to 5 words, caps at 5, case-insensitive subfolder match to the canonical name, throws ParseError on zero key points only if the document returned none AND summary is empty
// claudeClient.ts (ResearchClient)
overviewPdf(pdfName: string, subfolders: string[], pdfBase64: string, pageOffset: number): Promise<PdfOverview>;
mergeOverviews(pdfName: string, candidates: PdfOverview[]): Promise<PdfOverview>;     // text-only call, no tools
// writer.ts
writePdfOverview(args: { container: string; asRoot: boolean; pdfName: string; overview: PdfOverview; existingSubfolders: string[]; date: string }):
  Promise<{ overviewPath: string; entries: { folder: string; entryPath: string; point: KeyPoint }[] }>;
writeKeypointNotes(folder: string, topic: string, subtopic: string, notes: NoteContent[], date: string): Promise<{ noteTitles: string[] }>;
// noteTemplate.ts
renderPdfOverview(o: { pdfName: string; overview: PdfOverview; links: { point: KeyPoint; target: string }[]; asRoot: boolean }, date: string): string;
```
Stage 1 (`PdfFlow.run`): read, hash-resume check, split, `overviewPdf` per chunk (sequentially, cached across retries as today), `mergeOverviews` when more than one chunk, `writer.writePdfOverview` (folders + entry notes + overview with `[[folder/Entry|Name]]` links and `(p. N)` references), enqueue one `keypoint` job per entry, `markProcessed`, emit `done`. Stage 2 (`KeypointFlow.run`): `client.notes(topic = pdfName, parents, { name, why: "<text> — from the PDF: <detail>" }, notesPerSubfolder)` (web search per `useWebSearch`), `writeKeypointNotes`, progress events with `ProgressSource.kind = "keypoint"` for `path = folder`; non-retryable errors are reported for that key point only.

- [ ] **Step 1: Write the failing tests.**
```ts
// parse / prompts / client
test("parsePdfOverview: 5 points kept; 7 points capped to 5; 3 points stay 3 (no padding); names trimmed to 5 words; subfolder matched case-insensitively", () => {});
test("pdfOverviewPrompt: JSON only, at most 5, 'do not pad', (p. N) with offset, lists subfolders, document is untrusted", () => {});
test("mergeOverviewsPrompt lists every candidate and asks for the top 5 overall", () => {});
test("client.overviewPdf sends the document block first, no tools; mergeOverviews sends no document and no tools", () => {});
// writer / template
test("writePdfOverview outside a root: '<container>/<pdf> - Overview.md' has research-root true, 5 key point bullets with (p. N) and [[folder/Entry|Name]] links, one folder + entry note per point", () => {});
test("writePdfOverview inside a root: overview under Sources without the marker; a point whose subfolder matches an existing folder goes there, others go to From PDFs/<name>", () => {});
test("overview links resolve: every [[target]] in the overview equals a created entry note path", () => {});
test("thin document: 2 key points -> exactly 2 bullets and 2 folders", () => {});
// stage 1
test("pdf run: chunks -> overviewPdf per chunk with offsets, mergeOverviews once when chunked, not for a single chunk", () => {});
test("pdf run enqueues exactly 5 keypoint jobs for a 5-point overview, 2 for a 2-point one, and marks the hash processed", () => {});
test("retryable error in stage 1 does not resend finished chunks (cache kept) and does not enqueue jobs twice", () => {});
// stage 2
test("keypoint run writes notesPerSubfolder notes into its folder via client.notes with the PDF context in `why`", () => {});
test("one failing keypoint job (non-retryable) emits failed for it only; the other four still complete", () => {});
test("keypoint job with web search off passes the setting through; events use source kind 'keypoint'", () => {});
test("settings.mergeData keeps valid keypoint jobs and drops malformed ones", () => {});
```
- [ ] **Step 2:** run the files above — expected FAIL (capture it). **Step 3:** implement; then **delete the dead code**: `extractPdf`, `pdfPrompt`, `parsePdfExtraction`, `PdfExtraction`, `ExtractedNote`, `writeExtracted`, `mergeExtractions` and their tests. **Step 4:** `npm test` and `npm run build` pass. **Step 5: Commit** `feat: two-stage PDF research with a 5-point overview and one job per key point`.

---

### Task 19: Capabilities and README (items 16, 17)

**Files:** Modify `src/models.ts`, `src/settings.ts`; create `README.md`; tests extend `tests/models.test.ts`, `tests/settings.test.ts`.

**Interfaces:** `ModelInfo` gains optional `pdf?: boolean | null` and `webSearch?: boolean | null` (`null`/missing = unknown), filled by `parseModelsPage` from `capabilities.pdf_input.supported` and `capabilities.server_tools.web_search.supported` (a non-boolean or missing value gives `null`). `modelOptions(models, savedId, chosen, opts?: { useWebSearch: boolean })` returns options with `disabled?: boolean`; labels get ` (no PDF support)` when `pdf === false` (always disabled) and ` (no web search)` when `webSearch === false` and `opts.useWebSearch` (disabled only then). Cached models (`ModelCache`) carry the new fields; `mergeData` validation accepts them.

- [ ] **Item 16, Step 1: write the failing tests.**
```ts
test("parseModelsPage maps capabilities.pdf_input.supported and server_tools.web_search.supported; null capabilities -> unknown", () => {});
test("modelOptions: pdf false -> '(no PDF support)' and disabled; unknown -> normal", () => {});
test("modelOptions: web search false -> '(no web search)' disabled only when useWebSearch is on", () => {});
test("a disabled saved model keeps being selected with a warning that says to pick another", () => {});
test("mergeData keeps capability flags in the cache and tolerates old caches without them", () => {});
```
  **Step 2–4:** red, implement (settings tab passes `useWebSearch`; toggling it re-renders the dropdown options), green. **Step 5: Commit** `feat: disable models without PDF or web search support`.
- [ ] **Item 17, Step 1:** a test that reads `README.md` and asserts it mentions `main.js`, `manifest.json`, `styles.css`, `Topic+` and `paper+.pdf` / `paper.pdf+` (fails first because the file does not exist). **Step 2–3:** write `README.md`: what the plugin does, install (copy the three files into `<vault>/.obsidian/plugins/topic-research-folders/`, enable community plugins, add the API key), the two triggers (folder `Topic+`; PDF `paper+.pdf` or `paper.pdf+`, renamed back after triggering), review of suggestions (Notice button / command), status bar menu, settings summary, the cost warning (each PDF = 1 overview request plus up to 5 key-point jobs). **Step 4:** `npm test` and `npm run build`. **Step 5: Commit** `feat: README with install files and both triggers` (use `feat:`/`docs:` per the request's `feat:` list — `docs:` is acceptable for this commit).

---

## Manual check (after Task 19)

1. Create `Black holes+` and keep typing in another note while it runs: nothing interrupts you; the folder shows a spinner; the status bar reads `Researching Black holes…`; a Notice `Suggestions ready for Black holes` with **Review** appears; the spinner stays until you review. Clicking the status bar offers **Cancel all research jobs** (and **Review pending suggestions**). Close Obsidian before reviewing, reopen: the Notice and spinner return, no modal opens, no second API call.
2. Review → untick one folder → **Create**: the spinner runs while it writes; notes land; a Notice reports the result. Review → close the modal without Create: `Cancelled` (neutral), spinner gone.
3. Create `Black holes+` again after it exists: neutral `Already researched — use 'Research this folder' to run it again`; the command re-runs it.
4. Rename a PDF to `paper+.pdf` outside any research folder: it is renamed back to `paper.pdf`, the PDF shows a spinner (status `Analysing paper.pdf (chunk 1/N)…`), then a `paper/` folder appears next to it with `paper - Overview.md` (5 key points with page references and working links) and 5 key-point subfolders that fill in as their jobs run.
5. Do the same inside `Black holes/`: the overview lands in `Sources/`, matching subfolders receive their notes, others go to `From PDFs/`.
6. Rename to `paper.pdf+` instead: same result. Rename a 300-page PDF: a confirm dialog asks once.
7. Settings: pick a model from the list; models without PDF support are greyed with `(no PDF support)`; with an invalid key the red error shows and the list is kept.

---

# Tasks 20–23: folder context, subject notes, quiz files, README/icon (items E–H)

> Same rules as before: test-first (capture the red run), `npm test` and `npm run build` pass before each section is committed, **one commit per section (E, F, G, H)**, fake HTTP only, pure logic never imports `obsidian`.

## Decisions

- `buildContext` is **async** (`Promise<FolderContext>`): reading an Overview's one-line summary needs `vault.read`. It takes a minimal `ContextVault` (`children`, `read`), which `VaultLike` already satisfies.
- The context block is built once per job from the target path (topic folder; key-point folder; for a PDF the folder that receives its output). It is passed to the client as a ready-made prompt string, so the prompts stay pure string functions.
- The 2,000-character cap applies to the whole block returned by `contextToPrompt` (fixed instruction included). Trimming drops the furthest ancestor first, then siblings.
- Subject: the outline (and PDF overview) returns `subject` / `codeLanguage`; the nearest research-root ancestor's Overview frontmatter is read **live** (so a user's edit wins) and passed as a hint. Key-point jobs read the nearest root at run time; a PDF inside a root stores its own subject on the job only when it differs from the root's.
- `NoteContent.extras` is optional. Invalid or missing extras never throw: if the extras object still has a usable general `example` the note falls back to `general`, otherwise the note has no extra section.
- `ResearchClient.notes` now returns `NotesResult { notes, quiz }`. Questions and answers come from the **same call**; mismatched counts are trimmed to the shorter.
- Answer links use the overview's unambiguous form `[[<folder path>/<Title>|<Title>]]` (renders as "Event horizon").
- The quiz-flow wiring tests (`tests/quizFlow.test.ts`) were written after the writer/flow code, driven by the red `tests/quiz.test.ts`; `extractJson` now tries the whole reply first because code fences inside quiz strings (e.g. `println!("{}")`) were mistaken for the JSON wrapper.
- Quiz files are written as a pair with a shared collision suffix (`... - Questions (2).md` / `... - Answers (2).md`) so the two links always match.

## File Structure (Tasks 20–23)

```
  LICENSE                      NEW (MIT)
  README.md                    rewritten (item 12)
  assets/icon.svg              NEW (item 11)
  src/
    context.ts                 NEW pure: buildContext, contextToPrompt (item 1–3)
    subjects.ts                NEW pure: SUBJECTS table (item 4–6)
    quiz.ts                    NEW pure: renderQuestions, renderAnswers (item 8)
    icon.ts                    NEW: ICON_ID, ICON_SVG_INNER
    ui/ribbon.ts               NEW pure: ribbon/status menu items
    types.ts                   Outline/PdfOverview + subject; NoteContent.extras; Quiz, NotesResult; Job + subject fields
    research/prompts.ts        context block in every prompt; subject sections + quiz fields in notesPrompt
    research/parse.ts          parseOutline subject; parseNotes -> NotesResult (extras + quiz)
    vault/noteTemplate.ts      no Q&A block; subject section; subject frontmatter on Overview
    vault/writer.ts            context(path); writes Questions/Answers files
```

### Task 20: Folder context (section E, items 1–3)
- [x] Tests (`tests/context.test.ts`): plain folder chain; nested research roots (summary + subfolders); siblings listed without the target and with a "do not repeat" instruction; the 2,000-char trim keeps the nearest ancestors. Red, implement `src/context.ts`, wire into the research, PDF and key-point flows and all prompts, green. **Commit** `feat: give every research prompt the context of the folders above it`.

### Task 21: Subject-specific notes (section F, items 4–6)
- [x] Tests (`tests/subjects.test.ts`, extend parse/prompts/noteTemplate/flows): outline returns `subject`/`codeLanguage`, saved in Overview frontmatter, inherited by nested topics and PDFs, user edit wins; each subject renders its section between "In plain words" and "My notes"; code blocks carry the language tag; missing/invalid `extras` falls back without crashing. **Commit** `feat: subject-specific sections in notes`.

### Task 22: Questions and Answers files (section G, items 7–9)
- [x] Tests: no `## Questions & Answers` in any template (Task 3 snapshots updated); `<Subfolder> - Questions.md` / `- Answers.md` content; same API call; mismatch trimmed; coding questions carry code blocks. **Commit** `feat: separate Questions and Answers files per subfolder`.

### Task 23: README, icon, description (section H, items 10–12)
- [x] Tests: manifest name/description (≤250 chars, ends with a period); icon.svg uses `currentColor`, `viewBox="0 0 100 100"`, no external references, and matches `ICON_SVG_INNER`; ribbon menu has the three items; README sections in the requested order; LICENSE is MIT. **Commit** `feat: README, icon, ribbon button and manifest description`.

## Manual check (after Task 23)

1. `Programming/Rust/Ownership+`: notes include Rust code blocks and the level matches the parent folders; each subfolder has `<Subfolder> - Questions.md` and `- Answers.md`; notes have no Q&A section.
2. `History/World War 2+`: notes have Timeline and Key people.
3. The icon appears in the ribbon and the status bar.
4. The README renders cleanly on GitHub.

---

# Tasks 24–29: explorer status icons, pop-up fixes, learning order, sources, undo, README (sections 1–6)

> Same rules as before: test-first (capture the red run), `npm test` and `npm run build` pass before each section is committed, **one commit per section**, fake HTTP only, pure logic never imports `obsidian`.

## Decisions

- **State machine** (`src/ui/marks.ts`, pure): a `MarkBoard` holds one mark per path: `working`, `ready`, `done`, `failed`; cancelled removes the mark. Allowed moves: anything → `working`; `working` → `ready | done | failed`; nothing → `ready` (a restored review) or `failed` (a run rejected before it started); `done` removes itself after 3 s (injected `later`). Illegal moves (e.g. `ready → done`) are ignored. `iconFor(mark)` maps each state to icon, tooltip and click action (`review`, `retry`, none).
- The hub owns the board. `HubUi` gets `setMarks(marks)` (ready/done/failed only); `setSpinners` now carries only *working* paths (a pending review is a sparkle, not a spinner). The Notice "Suggestions ready — Review" and the status text "Suggestions ready (N)" are removed.
- **Fallback:** the explorer layer reports the ready paths it could not place; `main.ts` then shows `✦ N ready to review` in the status bar, and clicking it opens the review. Never a popup.
- Failed marks are for research and PDF runs (a key point failure keeps its error notice). Retry = the same call as "Research this folder" / the PDF trigger for that path.
- **Pop-up:** pure helpers in `src/ui/selection.ts` (row model with add/reorder/select-all, `insideLine`); the modal only renders them. Drag uses pointer events on a handle; ↑/↓ buttons do the same move.
- **Numbering:** done in `selectApproved` (pure) from the final row order, so created folders are `01 - Name`; the prefix is added after `sanitiseName`'s 100-character cap. A setting `numberFolders` (default on) turns it off. The numbered names are what the approved job carries, so the Overview's "Study path" list (ordered, linking each folder) follows without extra state.
- **Sources:** `ClaudeClient.call` returns the text plus the citations found in `web_search_tool_result` / `citations` blocks (real URLs only, deduplicated, max 5 per call). `parseNotes` attaches them to every note of that call; the `## Sources` section goes last (after My notes). PDF-derived notes list `[[paper.pdf]] (p. N–M)` from the key point's pages; no sources → no section.
- **Undo:** each flow records what it created (folders, files, the suffix rename) via the writer into a run log (`runLog`, last 20 runs) in plugin data. `planUndo` (pure) decides per item: delete (unedited file), keep (edited since creation: `mtime > ctime + slack`, or folder with other files), and returns counts for the confirm modal. Deletion uses `vault.trash(file, true)`.
- Out of scope, left alone: popout-window spinner, settings-tab tests, cancel-again limitation.

### Task 24: Explorer status icons (section 1)
- [x] Tests (`tests/marks.test.ts`, hub tests updated): transitions, `iconFor`, done fade timer, reduced motion CSS, hub marks/no Notice, fallback status text. **Commit** `feat: show research state as an icon in the file explorer`.

### Task 25: Suggestion pop-up (section 2)
- [x] Tests (`tests/suggestionRows.test.ts`): full-width CSS, inside line, select all/none, add own row (empty ignored), move up/down/drag keeps order, keyboard handler. **Commit** `feat: pop-up shows context, select all, add and reorder`.

### Task 26: Learning order (section 3)
- [x] Tests: prompt asks simplest first, zero-padded prefixes follow the final order, collisions ` (2)`, setting off → no prefix, Study path list. **Commit** `feat: number folders in learning order`.

### Task 27: Sources (section 4)
- [ ] Tests: citation parsing, dedupe, cap 5, omission, PDF note source line. **Commit** `feat: list real sources at the end of each note`.

### Task 28: Undo last research (section 5)
- [ ] Tests: only logged items removed, edited files kept, non-empty folders kept, suffix rename undone only if empty, log capped at 20. **Commit** `feat: undo last research`.

### Task 29: README (section 6)
- [ ] Test: README mentions each feature and no longer the review Notice or loading modal. **Commit** `docs: README for the new features`.
