import { describe, expect, test } from "vitest";
import { pdfTriggerName } from "../src/pdf/trigger";

describe("pdfTriggerName", () => {
  test("pdfTriggerName table above, plus multi-character suffix and trailing spaces ('paper +.pdf' is a trigger, clean 'paper .pdf' trimmed to 'paper.pdf')", () => {
    const table: [string, { clean: string } | null][] = [
      ["paper+.pdf", { clean: "paper.pdf" }],
      ["paper.pdf+", { clean: "paper.pdf" }],
      ["paper.pdf", null],
      ["+.pdf", null],
      [".pdf+", null],
      [".pdf", null],
      ["", null],
      ["notes+.PDF", { clean: "notes.PDF" }],
      ["notes.Pdf+", { clean: "notes.Pdf" }],
      ["a.txt+", null],
      ["a+.txt", null],
      ["paper", null],
      ["paper+", null],
      ["paper +.pdf", { clean: "paper.pdf" }],
      ["paper.pdf +", { clean: "paper.pdf" }],
      ["  +.pdf", null],
      ["C++.pdf", { clean: "C+.pdf" }],
      ["my paper v2+.pdf", { clean: "my paper v2.pdf" }],
    ];
    for (const [name, want] of table) expect([name, pdfTriggerName(name, "+")]).toEqual([name, want]);

    expect(pdfTriggerName("paper go.pdf", " go")).toEqual({ clean: "paper.pdf" });
    expect(pdfTriggerName("paper.pdf go", " go")).toEqual({ clean: "paper.pdf" });
    expect(pdfTriggerName("paper!!.pdf", "!!")).toEqual({ clean: "paper.pdf" });
    expect(pdfTriggerName("paper!.pdf", "!!")).toBeNull();
    expect(pdfTriggerName("!!.pdf", "!!")).toBeNull();
    // An empty suffix never triggers.
    expect(pdfTriggerName("paper.pdf", "")).toBeNull();
  });
});
