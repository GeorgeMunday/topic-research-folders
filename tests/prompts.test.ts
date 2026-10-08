import { test, expect } from "vitest";
import { outlinePrompt, notesPrompt, pdfPrompt } from "../src/research/prompts";

test("subtopic prompt names parent chain", () =>
  expect(outlinePrompt("Event horizon", ["Black holes", "Anatomy"], 6)).toContain("Black holes > Anatomy"));
test("pdf prompt lists subfolders and offset", () => {
  const p = pdfPrompt("T", ["Anatomy", "History"], 50);
  expect(p).toContain("Anatomy"); expect(p).toContain("51"); expect(p).toMatch(/JSON only/i);
});
test("notes prompt requires JSON only and 12-year-old wording", () => {
  const p = notesPrompt("T", [], { name: "Sub", why: "w" }, 4);
  expect(p).toMatch(/JSON only/i); expect(p).toContain("12-year-old"); expect(p).toContain("Sub");
});
