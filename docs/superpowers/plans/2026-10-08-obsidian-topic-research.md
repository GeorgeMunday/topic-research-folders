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
