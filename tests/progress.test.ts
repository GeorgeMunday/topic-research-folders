import { test, expect } from "vitest";
import { ProgressTracker, CANCELLED_MESSAGE, noticeFor } from "../src/progress";

const src = { kind: "research" as const, resumed: false };

test("tracker activates a path on a step and deactivates it on done", () => {
  const t = new ProgressTracker();
  t.handle("A", { kind: "step", text: "Searching the web…" }, src);
  expect(t.active()).toEqual(["A"]);
  t.handle("A", { kind: "done", folders: 2, notes: 5 }, src);
  expect(t.active()).toEqual([]);
});

test("tracker deactivates on failed, including CANCELLED_MESSAGE", () => {
  const t = new ProgressTracker();
  t.handle("A", { kind: "step", text: "x" }, src);
  t.handle("B", { kind: "step", text: "y" }, src);
  t.handle("A", { kind: "failed", error: "boom" }, src);
  expect(t.active()).toEqual(["B"]);
  t.handle("B", { kind: "failed", error: CANCELLED_MESSAGE }, src);
  expect(t.active()).toEqual([]);
});

test("statusSuffix is the latest step text of the most recently updated active path; empty when none", () => {
  const t = new ProgressTracker();
  expect(t.statusSuffix()).toBe("");
  t.handle("A", { kind: "step", text: "one" }, src);
  t.handle("B", { kind: "step", text: "two" }, src);
  expect(t.statusSuffix()).toBe("two");
  t.handle("A", { kind: "step", text: "three" }, src);
  expect(t.statusSuffix()).toBe("three");
  expect(t.active()).toEqual(["A", "B"]);
  t.handle("A", { kind: "done", folders: 0, notes: 0 }, src);
  expect(t.statusSuffix()).toBe("two");
  t.handle("B", { kind: "done", folders: 0, notes: 0 }, src);
  expect(t.statusSuffix()).toBe("");
});

test("writing events render as 'Writing folder 2 of 5: Anatomy'", () => {
  const t = new ProgressTracker();
  t.handle("A", { kind: "writing", index: 2, total: 5, name: "Anatomy" }, src);
  expect(t.statusSuffix()).toBe("Writing folder 2 of 5: Anatomy");
  t.handle("A", { kind: "itemDone", name: "Anatomy", ok: true }, src);
  expect(t.statusSuffix()).toBe("Writing folder 2 of 5: Anatomy");
  t.handle("A", { kind: "outline", outline: { topic: "T", summary: "", subfolders: [] } }, src);
  expect(t.statusSuffix()).toBe("Choosing folders…");
});

test("clear(path) and clear() remove paths and notify subscribers once", () => {
  const t = new ProgressTracker();
  let n = 0;
  const off = t.onChange(() => { n++; });
  t.handle("A", { kind: "step", text: "a" }, src);
  t.handle("B", { kind: "step", text: "b" }, src);
  expect(n).toBe(2);
  t.handle("B", { kind: "step", text: "b" }, src); // no-op
  expect(n).toBe(2);
  t.clear("A");
  expect(n).toBe(3);
  expect(t.active()).toEqual(["B"]);
  t.clear("A"); // nothing changed
  expect(n).toBe(3);
  t.handle("C", { kind: "step", text: "c" }, src);
  expect(n).toBe(4);
  t.clear();
  expect(n).toBe(5);
  expect(t.active()).toEqual([]);
  t.clear();
  expect(n).toBe(5);
  off();
  t.handle("D", { kind: "step", text: "d" }, src);
  expect(n).toBe(5);
});

const ctx = { modalOpen: false, topic: "Black holes" };
test("noticeFor: null for pdf sources, non-terminal events and an open modal", () => {
  const pdf = { kind: "pdf" as const, resumed: false };
  expect(noticeFor("A", { kind: "done", folders: 1, notes: 1 }, pdf, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "step", text: "x" }, src, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "writing", index: 1, total: 2, name: "n" }, src, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "done", folders: 1, notes: 1 }, src, { ...ctx, modalOpen: true })).toBeNull();
});
test("noticeFor: done with singular and plural", () => {
  expect(noticeFor("A", { kind: "done", folders: 1, notes: 1 }, src, ctx)).toEqual({ text: "Researched Black holes: 1 folder, 1 note", error: false });
  expect(noticeFor("A", { kind: "done", folders: 3, notes: 0 }, src, ctx)).toEqual({ text: "Researched Black holes: 3 folders, 0 notes", error: false });
});
test("noticeFor: failed and itemDone", () => {
  expect(noticeFor("A", { kind: "failed", error: CANCELLED_MESSAGE }, src, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "failed", error: "boom" }, src, ctx)).toEqual({ text: "Research failed for Black holes: boom", error: true });
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: false, error: "bad" }, src, ctx)).toEqual({ text: 'Could not research "Anatomy": bad', error: true });
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: false }, src, ctx)?.text).toBe('Could not research "Anatomy": unknown error');
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: true }, src, ctx)).toBeNull();
});
