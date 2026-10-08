import { test, expect } from "vitest";
import { renderNote, renderOverview, renderSourceSummary } from "../src/vault/noteTemplate";
import type { NoteContent } from "../src/types";

const note: NoteContent = { title: "Event horizon", summary: "The point of no return.",
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

test("newline in topic yields single-line quoted frontmatter", () => {
  const md = renderNote(note, { topic: "Line one\nline two\r\nthree", subtopic: "A", date: "2026-10-08", source: "a\nb.pdf", pages: "1\n2" });
  const fm = md.split("\n---")[0].split("\n");
  expect(fm).toContain('topic: "Line one line two three"');
  expect(fm).toContain('source: "[[a b.pdf]]"');
  expect(fm).toContain('pages: "1 2"');
});
test("multi-line summary stays inside one blockquote line", () => {
  const md = renderNote({ ...note, summary: "First line\nsecond line" }, { topic: "T", subtopic: "S", date: "2026-10-08" });
  expect(md).toContain("> First line second line\n");
  expect(md).not.toContain("\nsecond line\n");
});
test("backslash in topic escaped", () => {
  expect(renderNote(note, { topic: "C:\\notes", subtopic: "A", date: "2026-10-08" }))
    .toContain('topic: "C:\\\\notes"');
});
test("empty keyPoints does not crash", () => {
  const md = renderNote({ ...note, keyPoints: [] }, { topic: "T", subtopic: "S", date: "2026-10-08" });
  expect(md).toContain("## Key points\n\n## In plain words");
});
test("multi-line title and key points collapse to one line", () => {
  const md = renderNote({ ...note, title: "Two\nlines", keyPoints: ["a\nb"] }, { topic: "T", subtopic: "S", date: "2026-10-08" });
  expect(md).toContain("# Two lines\n");
  expect(md).toContain("## Key points\n- a b\n");
});
test("multi-line subfolder why stays single-line in overview", () => {
  const md = renderOverview({ topic: "T", summary: "S", subfolders: [{ name: "A", why: "x\ny" }] },
    [{ subfolder: "A", noteTitles: [] }], "2026-10-08");
  expect(md).toContain("  x y\n");
});
