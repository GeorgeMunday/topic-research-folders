import { describe, expect, test } from "vitest";
import { containerFor, pdfTriggerName } from "../src/pdf/trigger";

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

describe("containerFor", () => {
  test("containerFor: pdf outside any root -> '<dir>/<stem>'; inside a root -> the root (overview in <root>/Sources)", () => {
    expect(containerFor("Docs/paper.pdf", null)).toEqual({ container: "Docs/paper", asRoot: true });
    expect(containerFor("A/B/My Paper.PDF", null)).toEqual({ container: "A/B/My Paper", asRoot: true });
    expect(containerFor("paper.pdf", null)).toEqual({ container: "paper", asRoot: true });
    expect(containerFor("Topic/Anatomy/paper.pdf", { root: "Topic" })).toEqual({ container: "Topic", asRoot: false });
    expect(containerFor("Science/Topic/paper.pdf", { root: "Science/Topic" })).toEqual({ container: "Science/Topic", asRoot: false });
  });
});
