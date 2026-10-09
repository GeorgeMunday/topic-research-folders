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
      expect(mergeData(raw)).toEqual({ settings: DEFAULT_SETTINGS, jobs: [], processedPdfs: {}, modelCache: null });
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
