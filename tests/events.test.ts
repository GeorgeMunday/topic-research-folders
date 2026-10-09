import { describe, expect, test } from "vitest";
import { decideRename } from "../src/events";

const suffix = "+";

describe("decideRename", () => {
  test("folder moved to a new parent (same basename) is ignored", () => {
    expect(decideRename({ isFolder: true, oldPath: "A/Topic", newPath: "B/Topic", suffix })).toEqual({ action: "ignore" });
  });
  test("descendant folder of a moved folder (same basename) is ignored", () => {
    expect(decideRename({ isFolder: true, oldPath: "A/Topic/Sub", newPath: "B/Topic/Sub", suffix })).toEqual({ action: "ignore" });
  });
  test("folder renamed (basename changed) is a folder-event", () => {
    expect(decideRename({ isFolder: true, oldPath: "Black holes", newPath: "Black holes+", suffix })).toEqual({ action: "folder-event", path: "Black holes+" });
  });
  test("a file renamed to a pdf trigger name (either form, any case) is a pdf-event", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/paper.pdf", newPath: "T/paper+.pdf", suffix })).toEqual({ action: "pdf-event", path: "T/paper+.pdf" });
    expect(decideRename({ isFolder: false, oldPath: "T/paper.pdf", newPath: "T/paper.pdf+", suffix })).toEqual({ action: "pdf-event", path: "T/paper.pdf+" });
    expect(decideRename({ isFolder: false, oldPath: "T/u.PDF", newPath: "T/u+.PDF", suffix })).toEqual({ action: "pdf-event", path: "T/u+.PDF" });
  });
  test("a plain pdf rename is ignored, including the plugin's rename back to the clean name", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/unknown.pdf", newPath: "T/new.pdf", suffix })).toEqual({ action: "ignore" });
    expect(decideRename({ isFolder: false, oldPath: "T/paper+.pdf", newPath: "T/paper.pdf", suffix })).toEqual({ action: "ignore" });
    expect(decideRename({ isFolder: false, oldPath: "T/paper+.pdf", newPath: "T/paper (2).pdf", suffix })).toEqual({ action: "ignore" });
  });
  test("a trigger-named pdf moved along with its folder (same basename) does not retrigger", () => {
    expect(decideRename({ isFolder: false, oldPath: "A/paper+.pdf", newPath: "B/paper+.pdf", suffix })).toEqual({ action: "ignore" });
  });
  test("the suffix comes from the caller", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/p.pdf", newPath: "T/p go.pdf", suffix: " go" })).toEqual({ action: "pdf-event", path: "T/p go.pdf" });
    expect(decideRename({ isFolder: false, oldPath: "T/p.pdf", newPath: "T/p+.pdf", suffix: " go" })).toEqual({ action: "ignore" });
  });
  test("non-pdf file is ignored", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/a.md", newPath: "T/b.md", suffix })).toEqual({ action: "ignore" });
    expect(decideRename({ isFolder: false, oldPath: "T/a.md", newPath: "T/a+.md", suffix })).toEqual({ action: "ignore" });
  });
});
