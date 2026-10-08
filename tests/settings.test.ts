import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, mergeData, validateSuffix } from "../src/settings";

describe("settings", () => {
  test("defaults", () =>
    expect(DEFAULT_SETTINGS).toEqual({ apiKey: "", model: "claude-sonnet-5-5", useWebSearch: true,
      triggerSuffix: "+", stripSuffix: true, maxSubfolders: 6, notesPerSubfolder: 3, maxDepth: 3, maxConcurrent: 2,
      maxRetries: 4, processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200 }));

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
      expect(mergeData(raw)).toEqual({ settings: DEFAULT_SETTINGS, jobs: [], processedPdfs: {} });
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
