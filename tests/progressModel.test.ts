import { expect, test } from "vitest";
import { initialState, reduce, progressFraction, summaryText } from "../src/ui/progressModel";
import { CANCELLED_MESSAGE } from "../src/progress";
import type { Outline } from "../src/types";

const outline: Outline = { topic: "Bats", summary: "s", subfolders: [{ name: "A", why: "w" }, { name: "B", why: "w" }] };
const writing = () => reduce(initialState("Bats"), { kind: "approved", names: ["A", "B"] });

test("initial state is loading with the topic and no items", () => {
  const s = initialState("Bats");
  expect(s.phase).toBe("loading");
  expect(s.topic).toBe("Bats");
  expect(s.items).toEqual([]);
});

test("step updates the step line while loading", () => {
  const s = reduce(initialState("Bats"), { kind: "step", text: "Searching the web…" });
  expect(s.step).toBe("Searching the web…");
  expect(s.phase).toBe("loading");
});

test("outline moves loading -> choose and keeps the outline", () => {
  const s = reduce(initialState("Bats"), { kind: "outline", outline });
  expect(s.phase).toBe("choose");
  expect(s.outline).toBe(outline);
});

test("approved moves choose -> writing with one pending item per name", () => {
  const s = writing();
  expect(s.phase).toBe("writing");
  expect(s.items).toEqual([{ name: "A", status: "pending" }, { name: "B", status: "pending" }]);
  expect(s.total).toBe(2);
  expect(s.index).toBe(0);
});

test("approved with zero names", () => {
  const s = reduce(initialState("Bats"), { kind: "approved", names: [] });
  expect(s.phase).toBe("writing");
  expect(s.items).toEqual([]);
  expect(s.total).toBe(0);
  expect(progressFraction(s)).toBe(0);
});

test("writing marks the current item working and sets index, total and current name", () => {
  const s = reduce(writing(), { kind: "writing", index: 2, total: 2, name: "B" });
  expect(s.items[1].status).toBe("working");
  expect(s.items[0].status).toBe("pending");
  expect([s.index, s.total, s.current]).toEqual([2, 2, "B"]);
});

test("itemDone marks ok or error (with reason)", () => {
  let s = reduce(writing(), { kind: "itemDone", name: "A", ok: true });
  s = reduce(s, { kind: "itemDone", name: "B", ok: false, error: "boom" });
  expect(s.items[0].status).toBe("ok");
  expect(s.items[1]).toEqual({ name: "B", status: "error", error: "boom" });
});

test("done -> phase done with folders and notes", () => {
  const s = reduce(writing(), { kind: "done", folders: 5, notes: 15 });
  expect(s.phase).toBe("done");
  expect([s.folders, s.notes]).toEqual([5, 15]);
  expect(summaryText(s)).toBe("Done — 5 folders, 15 notes");
});

test("summaryText uses singular for 1", () => {
  const s = reduce(writing(), { kind: "done", folders: 1, notes: 1 });
  expect(summaryText(s)).toBe("Done — 1 folder, 1 note");
});

test("failed -> phase failed with the error; CANCELLED_MESSAGE -> cancelled", () => {
  const f = reduce(writing(), { kind: "failed", error: "bad key" });
  expect(f.phase).toBe("failed");
  expect(f.error).toBe("bad key");
  expect(reduce(writing(), { kind: "failed", error: CANCELLED_MESSAGE }).phase).toBe("cancelled");
});

test("progressFraction counts finished items over total and never exceeds 1", () => {
  let s = writing();
  expect(progressFraction(s)).toBe(0);
  s = reduce(s, { kind: "itemDone", name: "A", ok: true });
  expect(progressFraction(s)).toBe(0.5);
  s = reduce(s, { kind: "itemDone", name: "B", ok: false, error: "x" });
  expect(progressFraction(s)).toBe(1);
  expect(progressFraction({ ...s, total: 1 })).toBe(1);
});

test("an outline arriving after the user closed the loading modal is still reduced", () => {
  const s = reduce(reduce(initialState("Bats"), { kind: "step", text: "x" }), { kind: "outline", outline });
  expect(s.phase).toBe("choose");
});

test("actions after a terminal phase are ignored", () => {
  const done = reduce(writing(), { kind: "done", folders: 1, notes: 2 });
  expect(reduce(done, { kind: "failed", error: "late" })).toBe(done);
  const failed = reduce(writing(), { kind: "failed", error: "bad" });
  expect(reduce(failed, { kind: "done", folders: 1, notes: 2 })).toBe(failed);
  expect(reduce(failed, { kind: "failed", error: "bad" })).toBe(failed);
  expect(reduce(failed, { kind: "step", text: "x" })).toBe(failed);
});
