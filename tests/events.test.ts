import { describe, expect, test } from "vitest";
import { decideRename } from "../src/events";

const processed = { h1: { path: "T/old.pdf", date: "d" }, h2: { path: "T/other.pdf", date: "d" } };

describe("decideRename", () => {
  test("folder moved to a new parent (same basename) is ignored", () => {
    expect(decideRename({ isFolder: true, oldPath: "A/Topic", newPath: "B/Topic", processed })).toEqual({ action: "ignore" });
  });
  test("descendant folder of a moved folder (same basename) is ignored", () => {
    expect(decideRename({ isFolder: true, oldPath: "A/Topic/Sub", newPath: "B/Topic/Sub", processed })).toEqual({ action: "ignore" });
  });
  test("folder renamed (basename changed) is a folder-event", () => {
    expect(decideRename({ isFolder: true, oldPath: "Black holes", newPath: "Black holes+", processed })).toEqual({ action: "folder-event", path: "Black holes+" });
  });
  test("pdf with a known old path updates the processed entry", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/old.pdf", newPath: "T/new.pdf", processed }))
      .toEqual({ action: "update-processed", hash: "h1", path: "T/new.pdf" });
  });
  test("pdf match is by exact path", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/OLD.pdf", newPath: "T/x.pdf", processed })).toEqual({ action: "pdf-event", path: "T/x.pdf" });
  });
  test("unknown pdf is a pdf-event", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/unknown.pdf", newPath: "T/new.pdf", processed })).toEqual({ action: "pdf-event", path: "T/new.pdf" });
  });
  test("uppercase extension counts as pdf", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/u.PDF", newPath: "T/v.PDF", processed })).toEqual({ action: "pdf-event", path: "T/v.PDF" });
  });
  test("non-pdf file is ignored", () => {
    expect(decideRename({ isFolder: false, oldPath: "T/a.md", newPath: "T/b.md", processed })).toEqual({ action: "ignore" });
  });
});
