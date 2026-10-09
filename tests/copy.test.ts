import { readFileSync } from "fs";
import { expect, test } from "vitest";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("settings and confirm copy describe the PDF suffix trigger, not dropped folders or batches", () => {
  const settings = src("settings.ts");
  for (const stale of ["dropped into a researched folder", "batch of PDFs", "Remove suffix from folder name\"", "A new folder whose name ends with this"]) {
    expect([stale, settings.includes(stale)]).toEqual([stale, false]);
  }
  expect(settings).toContain("paper+.pdf");
  expect(settings).toContain("Ask before analysing a single PDF with more pages than this");
  const modal = src("ui/ConfirmModal.ts");
  expect(modal).not.toContain("Analyse PDFs?");
  expect(modal).toContain("Analyse this PDF?");
});
