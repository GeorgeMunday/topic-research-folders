import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, mergeData, validateSuffix } from "../src/settings";

describe("settings", () => {
  test("defaults", () =>
    expect(DEFAULT_SETTINGS).toEqual({ apiKey: "", model: "claude-sonnet-5-5", modelChosen: false, useWebSearch: true,
      triggerSuffix: "+", stripSuffix: true, maxSubfolders: 6, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 2,
      maxRetries: 4, processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200 }));

  test("mergeData: model other than the default without the flag -> modelChosen true; no model -> false", () => {
    expect(mergeData({ settings: { model: "claude-opus-9" } }).settings.modelChosen).toBe(true);
    expect(mergeData({ settings: {} }).settings.modelChosen).toBe(false);
    expect(mergeData({ settings: { model: "claude-sonnet-5-5" } }).settings.modelChosen).toBe(false);
    expect(mergeData({ settings: { model: "x", modelChosen: false } }).settings.modelChosen).toBe(false);
    expect(mergeData({ settings: { model: "x", modelChosen: true } }).settings.modelChosen).toBe(true);
    expect(mergeData({ settings: { modelChosen: "yes" } }).settings.modelChosen).toBe(false);
    expect(mergeData({ settings: { model: "x", modelChosen: "yes" } }).settings.modelChosen).toBe(false);
  });

  test("suffix validation", () => {
    expect(validateSuffix("+")).toBeNull();
    expect(validateSuffix("*")).toMatch(/not allowed/);
    expect(validateSuffix("")).toMatch(/empty/);
  });

  test("every illegal character is rejected", () => {
    for (const c of ['*', '"', "\\", "/", "<", ">", ":", "|", "?"]) {
      expect(validateSuffix(`a${c}`)).toMatch(/not allowed/);
    }
    expect(validateSuffix("   ")).toMatch(/empty/);
    expect(validateSuffix(" -research")).toBeNull();
  });

  test("loadData merges partial saved data with defaults", () => {
    const d = mergeData({ settings: { apiKey: "k", maxDepth: 2 } });
    expect(d.settings).toEqual({ ...DEFAULT_SETTINGS, apiKey: "k", maxDepth: 2 });
    expect(d.jobs).toEqual([]);
    expect(d.processedPdfs).toEqual({});
  });

  test("null / junk raw data yields defaults", () => {
    for (const raw of [null, undefined, 5, "x", []]) {
      expect(mergeData(raw)).toEqual({ settings: DEFAULT_SETTINGS, jobs: [], processedPdfs: {}, modelCache: null, pendingReviews: [] });
    }
  });

  test("keeps saved jobs and processedPdfs", () => {
    const jobs = [{ id: "pdf:a.pdf", kind: "pdf", path: "a.pdf" }];
    const processedPdfs = { h: { path: "a.pdf", date: "2026-01-01" } };
    const d = mergeData({ jobs, processedPdfs });
    expect(d.jobs).toEqual(jobs);
    expect(d.processedPdfs).toEqual(processedPdfs);
  });

  test("ignores wrong-typed values", () => {
    const d = mergeData({
      settings: { apiKey: 5, model: null, useWebSearch: "yes", maxDepth: "3", maxConcurrent: NaN, stripSuffix: 1 },
      jobs: "nope",
      processedPdfs: [1],
    });
    expect(d.settings).toEqual(DEFAULT_SETTINGS);
    expect(d.jobs).toEqual([]);
    expect(d.processedPdfs).toEqual({});
  });

  test("clamps numeric settings into range", () => {
    const hi = mergeData({ settings: { maxSubfolders: 99, notesPerSubfolder: 99, maxDepth: 99, maxConcurrent: 99,
      pdfPagesPerChunk: 999, maxRetries: 99 } }).settings;
    expect(hi).toMatchObject({ maxSubfolders: 8, notesPerSubfolder: 5, maxDepth: 5, maxConcurrent: 5,
      pdfPagesPerChunk: 100, maxRetries: 10 });
    const lo = mergeData({ settings: { maxSubfolders: 0, notesPerSubfolder: 0, maxDepth: 0, maxConcurrent: 0,
      pdfPagesPerChunk: 1, maxRetries: -3, confirmAbovePages: -5 } }).settings;
    expect(lo).toMatchObject({ maxSubfolders: 3, notesPerSubfolder: 2, maxDepth: 1, maxConcurrent: 1,
      pdfPagesPerChunk: 10, maxRetries: 0, confirmAbovePages: 0 });
  });

  test("invalid saved triggerSuffix falls back to +", () => {
    expect(mergeData({ settings: { triggerSuffix: "*" } }).settings.triggerSuffix).toBe("+");
    expect(mergeData({ settings: { triggerSuffix: "" } }).settings.triggerSuffix).toBe("+");
    expect(mergeData({ settings: { triggerSuffix: "!!" } }).settings.triggerSuffix).toBe("!!");
  });
});

describe("mergeData entry validation", () => {
  test("research jobs need a done array of strings and a well-formed approved list", () => {
    const base = { id: "r", kind: "research", path: "T" };
    const good = { ...base, done: ["A"], approved: [{ name: "A", why: "w" }] };
    const noApproved = { ...base, done: [] };
    const bad = [
      { ...base },
      { ...base, done: "A" },
      { ...base, done: [1] },
      { ...base, done: [], approved: "x" },
      { ...base, done: [], approved: [{ why: "w" }] },
      { ...base, done: [], approved: [null] },
    ];
    expect(mergeData({ jobs: [good, noApproved, ...bad] }).jobs).toEqual([good, noApproved]);
  });

  test("drops malformed jobs", () => {
    const good = { id: "pdf:a.pdf", kind: "pdf", path: "a.pdf" };
    const d = mergeData({ jobs: [good, { kind: "pdf", path: "x" }, { id: "1", kind: "pdf" }, { id: "2", kind: "other", path: "p" }, null, 5] });
    expect(d.jobs).toEqual([good]);
  });
  test("keeps a pdf job's resume flag and drops a pdf job whose resume is not a boolean", () => {
    const resumed = { id: "pdf:a.pdf", kind: "pdf", path: "a.pdf", resume: true };
    const fresh = { id: "pdf:b.pdf", kind: "pdf", path: "b.pdf" };
    const d = mergeData({ jobs: [resumed, fresh, { id: "pdf:c.pdf", kind: "pdf", path: "c.pdf", resume: "yes" }] });
    expect(d.jobs).toEqual([resumed, fresh]);
  });
  test("keeps a processed entry's numeric 'at' and a pdf job's numeric triggeredAt", () => {
    const d = mergeData({
      processedPdfs: { a: { path: "a", date: "d", at: 123 }, b: { path: "b", date: "d", at: "x" }, c: { path: "c", date: "d" } },
      jobs: [
        { id: "pdf:a", kind: "pdf", path: "a", resume: true, triggeredAt: 5 },
        { id: "pdf:b", kind: "pdf", path: "b", triggeredAt: "soon" },
      ],
    });
    expect(d.processedPdfs).toEqual({ a: { path: "a", date: "d", at: 123 }, b: { path: "b", date: "d" }, c: { path: "c", date: "d" } });
    expect(d.jobs).toEqual([{ id: "pdf:a", kind: "pdf", path: "a", resume: true, triggeredAt: 5 }]);
  });
  test("drops malformed processedPdfs entries", () => {
    const d = mergeData({ processedPdfs: { ok: { path: "a", date: "d" }, a: { path: "a" }, b: { date: "d" }, c: null, d: "x" } });
    expect(d.processedPdfs).toEqual({ ok: { path: "a", date: "d" } });
  });
});

describe("mergeData modelCache", () => {
  const good = { id: "a", display_name: "A", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" };
  test("defaults to null", () => {
    expect(mergeData({}).modelCache).toBeNull();
    expect(mergeData({ modelCache: 5 }).modelCache).toBeNull();
  });
  test("keeps a valid cache", () => {
    const cache = { fetchedAt: "2026-10-09T00:00:00.000Z", models: [good] };
    expect(mergeData({ modelCache: cache }).modelCache).toEqual(cache);
  });
  test("drops an invalid cache", () => {
    expect(mergeData({ modelCache: { fetchedAt: 5, models: [good] } }).modelCache).toBeNull();
    expect(mergeData({ modelCache: { fetchedAt: "x", models: "nope" } }).modelCache).toBeNull();
    expect(mergeData({ modelCache: { models: [good] } }).modelCache).toBeNull();
  });
  test("drops invalid items one by one", () => {
    const cache = { fetchedAt: "2026-10-09T00:00:00.000Z", models: [
      good, { display_name: "no id", lifecycle: "active", created_at: "x" },
      { ...good, id: "weird", lifecycle: "unknown" }, null,
      { ...good, id: "dep", lifecycle: "deprecated" },
    ] };
    expect(mergeData({ modelCache: cache }).modelCache?.models.map((x) => x.id)).toEqual(["a", "dep"]);
  });
});

describe("mergeData pendingReviews", () => {
  const outline = { topic: "Black holes", summary: "s", subfolders: [{ name: "Anatomy", why: "a" }, { name: "Formation", why: "b" }] };
  test("defaults to an empty list", () => {
    expect(mergeData({}).pendingReviews).toEqual([]);
    expect(mergeData(null).pendingReviews).toEqual([]);
    expect(mergeData({ pendingReviews: "x" }).pendingReviews).toEqual([]);
  });
  test("valid entries survive mergeData", () => {
    const list = [{ path: "Topics/Black holes", outline }, { path: "Stars", outline: { ...outline, topic: "Stars", subfolders: [] } }];
    expect(mergeData({ pendingReviews: list }).pendingReviews).toEqual(list);
  });
  test("invalid entries are dropped one by one", () => {
    const good = { path: "T", outline };
    const bad = [
      null, 5, "x",
      { outline },
      { path: 5, outline },
      { path: "T" },
      { path: "T", outline: null },
      { path: "T", outline: { ...outline, topic: 1 } },
      { path: "T", outline: { ...outline, summary: undefined } },
      { path: "T", outline: { ...outline, subfolders: "nope" } },
      { path: "T", outline: { ...outline, subfolders: [{ name: "A" }] } },
      { path: "T", outline: { ...outline, subfolders: [{ name: 1, why: "w" }] } },
      { path: "T", outline: { ...outline, subfolders: [null] } },
    ];
    expect(mergeData({ pendingReviews: [bad[0], good, ...bad.slice(1)] }).pendingReviews).toEqual([good]);
  });
});

test("research jobs keep a string summary; a wrong-typed summary drops the job", () => {
  const base = { id: "r", kind: "research", path: "T", done: [], approved: [{ name: "A", why: "w" }] };
  expect(mergeData({ jobs: [{ ...base, summary: "s" }, { ...base, summary: 5 }] }).jobs).toEqual([{ ...base, summary: "s" }]);
});

test("mergeData keeps valid keypoint jobs and drops malformed ones", () => {
  const point = { name: "Big idea", text: "It matters (p. 3)", detail: "d", pages: "3" };
  const good = { id: "keypoint:R/Big idea/Big idea.md", kind: "keypoint", path: "R/Big idea/Big idea.md", folder: "R/Big idea", pdfName: "paper.pdf", topic: "paper", parents: [], point };
  const withSub = { ...good, id: "k2", path: "x.md", parents: ["A", "B"], point: { ...point, subfolder: "Anatomy" } };
  const bad = [
    { ...good, folder: 5 },
    { ...good, pdfName: undefined },
    { ...good, topic: null },
    { ...good, parents: "A" },
    { ...good, parents: [1] },
    { ...good, point: null },
    { ...good, point: { ...point, name: 1 } },
    { ...good, point: { ...point, text: undefined } },
    { ...good, point: { ...point, detail: [] } },
    { ...good, point: { ...point, pages: 3 } },
    { ...good, point: { ...point, subfolder: 7 } },
  ];
  expect(mergeData({ jobs: [good, withSub, ...bad] }).jobs).toEqual([good, withSub]);
});

test("keypoint jobs keep a string docSummary; a wrong-typed one drops the job; a missing one (older data) is kept", () => {
  const point = { name: "Big idea", text: "It matters (p. 3)", detail: "d", pages: "3" };
  const base = { id: "k", kind: "keypoint", path: "R/B.md", folder: "R", pdfName: "p.pdf", topic: "p", parents: [], point };
  const withSummary = { ...base, docSummary: "About stars." };
  expect(mergeData({ jobs: [withSummary, { ...base, id: "k2", path: "R/C.md", docSummary: 5 }, { ...base, id: "k3", path: "R/D.md" }] }).jobs)
    .toEqual([withSummary, { ...base, id: "k3", path: "R/D.md" }]);
});

describe("mergeData model capabilities", () => {
  test("cached capability flags are kept when booleans and dropped otherwise", () => {
    const mk = (extra: object) => ({ id: "a", display_name: "A", lifecycle: "active", created_at: "", ...extra });
    const cache = (models: object[]) => mergeData({ modelCache: { fetchedAt: "2026-01-01T00:00:00Z", models } }).modelCache!.models;
    expect(cache([mk({ pdf: false, webSearch: true })])[0]).toMatchObject({ pdf: false, webSearch: true });
    const odd = cache([mk({ pdf: "no", webSearch: null })])[0];
    expect(odd.pdf).toBeUndefined();
    expect(odd.webSearch).toBeUndefined();
    const old = cache([mk({})])[0];
    expect("pdf" in old).toBe(false);
  });
});

describe("mergeData keeps the subject of saved reviews and jobs", () => {
  const outline = { topic: "Rust", summary: "s", subfolders: [{ name: "A", why: "w" }] };
  test("a pending review keeps a valid subject and its language, and drops an unknown one", () => {
    const keep = mergeData({ pendingReviews: [{ path: "R", outline: { ...outline, subject: "coding", codeLanguage: "rust" } }] });
    expect(keep.pendingReviews[0].outline).toMatchObject({ subject: "coding", codeLanguage: "rust" });
    const drop = mergeData({ pendingReviews: [{ path: "R", outline: { ...outline, subject: "cooking", codeLanguage: "rust" } }] });
    expect(drop.pendingReviews[0].outline.subject).toBeUndefined();
    expect(drop.pendingReviews[0].outline.codeLanguage).toBeUndefined();
  });
  test("a saved research job keeps a valid subject; an unknown subject drops the job", () => {
    const job = { id: "research:R", kind: "research", path: "R", done: [], approved: [{ name: "A", why: "w" }], subject: "maths" };
    expect(mergeData({ jobs: [job] }).jobs).toEqual([job]);
    expect(mergeData({ jobs: [{ ...job, subject: "cooking" }] }).jobs).toEqual([]);
  });
});
