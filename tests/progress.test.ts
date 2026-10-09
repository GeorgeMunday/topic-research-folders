import { test, expect, describe } from "vitest";
import { ProgressTracker, CANCELLED_MESSAGE, ALREADY_RESEARCHED_MESSAGE, isNeutralMessage, noticeFor, RunGate, nextRunId, shouldOpenSession } from "../src/progress";

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

const ctx = { topic: "Black holes" };
test("noticeFor: null for non-terminal research events", () => {
  expect(noticeFor("A", { kind: "step", text: "x" }, src, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "writing", index: 1, total: 2, name: "n" }, src, ctx)).toBeNull();
  expect(noticeFor("A", { kind: "outline", outline: { topic: "T", summary: "", subfolders: [] } }, src, ctx)).toBeNull();
});
describe("noticeFor: pdf source", () => {
  const pdf = { kind: "pdf" as const, resumed: false };
  const pctx = { topic: "paper.pdf" };
  test("done -> overview ready with the key point count (singular and plural)", () => {
    expect(noticeFor("T/paper.pdf", { kind: "done", folders: 3, notes: 9 }, pdf, pctx)).toEqual({ text: "Overview ready for paper.pdf — researching 3 key points", error: false });
    expect(noticeFor("T/paper.pdf", { kind: "done", folders: 1, notes: 2 }, pdf, pctx)).toEqual({ text: "Overview ready for paper.pdf — researching 1 key point", error: false });
  });
  test("failed -> error 'Could not analyse'; neutral failures stay neutral", () => {
    expect(noticeFor("T/paper.pdf", { kind: "failed", error: "boom" }, pdf, pctx)).toEqual({ text: "Could not analyse paper.pdf: boom", error: true });
    expect(noticeFor("T/paper.pdf", { kind: "failed", error: CANCELLED_MESSAGE }, pdf, pctx)).toEqual({ text: CANCELLED_MESSAGE, error: false });
  });
  test("other events -> null", () => {
    expect(noticeFor("T/paper.pdf", { kind: "step", text: "x" }, pdf, pctx)).toBeNull();
    expect(noticeFor("T/paper.pdf", { kind: "itemDone", name: "x", ok: false, error: "bad" }, pdf, pctx)).toBeNull();
  });
});
describe("noticeFor: keypoint source", () => {
  const kp = { kind: "keypoint" as const, resumed: false };
  const kctx = { topic: "Key A" };
  test("failed -> error; neutral -> neutral; done and others -> null", () => {
    expect(noticeFor("T/Key A", { kind: "failed", error: "boom" }, kp, kctx)).toEqual({ text: 'Could not research "Key A": boom', error: true });
    expect(noticeFor("T/Key A", { kind: "failed", error: CANCELLED_MESSAGE }, kp, kctx)).toEqual({ text: CANCELLED_MESSAGE, error: false });
    expect(noticeFor("T/Key A", { kind: "done", folders: 1, notes: 3 }, kp, kctx)).toBeNull();
    expect(noticeFor("T/Key A", { kind: "step", text: "x" }, kp, kctx)).toBeNull();
  });
});
test("noticeFor: done with singular and plural", () => {
  expect(noticeFor("A", { kind: "done", folders: 1, notes: 1 }, src, ctx)).toEqual({ text: "Researched Black holes: 1 folder, 1 note", error: false });
  expect(noticeFor("A", { kind: "done", folders: 3, notes: 0 }, src, ctx)).toEqual({ text: "Researched Black holes: 3 folders, 0 notes", error: false });
});
test("noticeFor: failed and itemDone", () => {
  expect(noticeFor("A", { kind: "failed", error: "boom" }, src, ctx)).toEqual({ text: "Research failed for Black holes: boom", error: true });
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: false, error: "bad" }, src, ctx)).toEqual({ text: 'Could not research "Anatomy": bad', error: true });
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: false }, src, ctx)?.text).toBe('Could not research "Anatomy": unknown error');
  expect(noticeFor("A", { kind: "itemDone", name: "Anatomy", ok: true }, src, ctx)).toBeNull();
});

describe("RunGate", () => {
  const r = (runId: number) => ({ kind: "research" as const, resumed: false, runId });
  const step = { kind: "step" as const, text: "x" };
  const failed = { kind: "failed" as const, error: "boom" };
  test("accepts the first event of a run and later events of the same run", () => {
    const g = new RunGate();
    expect(g.accept("A", step, r(1))).toBe(true);
    expect(g.accept("A", { kind: "outline", outline: { topic: "A", summary: "", subfolders: [] } }, r(1))).toBe(true);
  });
  test("ignores a stale run after a new run started", () => {
    const g = new RunGate();
    g.accept("A", step, r(1));
    expect(g.accept("A", step, r(2))).toBe(true);
    expect(g.accept("A", failed, r(1))).toBe(false);
    expect(g.accept("A", step, r(1))).toBe(false);
  });
  test("ignores events of a cancelled run, and a new run can start afterwards", () => {
    const g = new RunGate();
    g.accept("A", step, r(1));
    g.cancel("A");
    expect(g.accept("A", failed, r(1))).toBe(false);
    expect(g.accept("A", step, r(2))).toBe(true);
    expect(g.accept("A", failed, r(1))).toBe(false);
  });
  test("a pre-start failed with a new runId is accepted and starts a run", () => {
    const g = new RunGate();
    g.accept("A", step, r(1));
    g.accept("A", { kind: "done", folders: 1, notes: 1 }, r(1));
    expect(g.accept("A", failed, r(2))).toBe(true);
    expect(g.currentRun("A")).toBe(2);
    expect(g.accept("A", failed, r(1))).toBe(false);
  });
  test("a duplicate failed within a run is accepted; events without a runId pass", () => {
    const g = new RunGate();
    g.accept("A", step, r(1));
    expect(g.accept("A", failed, r(1))).toBe(true);
    expect(g.accept("A", failed, r(1))).toBe(true);
    expect(g.accept("A", step, { kind: "research", resumed: false })).toBe(true);
  });
  test("a non-step event of a different run is ignored while the current run is live", () => {
    const g = new RunGate();
    g.accept("A", step, r(1));
    expect(g.accept("A", failed, r(2))).toBe(false);
  });
});

describe("run id uniqueness", () => {
  test("nextRunId is strictly increasing", () => {
    const a = nextRunId(), b = nextRunId();
    expect(b).toBeGreaterThan(a);
  });
  test("cancelling a pdf run does not drop a research run with the same numeric id", () => {
    const g = new RunGate();
    const pdf = { kind: "pdf" as const, resumed: false, runId: 7 };
    const res = { kind: "research" as const, resumed: false, runId: 7 };
    g.accept("a.pdf", { kind: "step", text: "x" }, pdf);
    g.cancel("a.pdf");
    expect(g.accept("a.pdf", { kind: "step", text: "x" }, pdf)).toBe(false);
    expect(g.accept("T", { kind: "step", text: "x" }, res)).toBe(true);
  });
});

describe("final-fix helpers", () => {
  test("shouldOpenSession: only for a fresh, non-restored step with no session", () => {
    expect(shouldOpenSession({ resumed: false, restored: false, hasSession: false })).toBe(true);
    expect(shouldOpenSession({ resumed: true, restored: false, hasSession: false })).toBe(false);
    expect(shouldOpenSession({ resumed: false, restored: true, hasSession: false })).toBe(false);
    expect(shouldOpenSession({ resumed: false, restored: false, hasSession: true })).toBe(false);
  });
  test("RunGate.live is true only while the current run has not ended", () => {
    const g = new RunGate();
    const src = { kind: "research" as const, resumed: false, runId: 5 };
    expect(g.live("A")).toBe(false);
    g.accept("A", { kind: "step", text: "x" }, src);
    expect(g.live("A")).toBe(true);
    g.accept("A", { kind: "done", folders: 1, notes: 1 }, src);
    expect(g.live("A")).toBe(false);
    g.accept("B", { kind: "step", text: "x" }, { kind: "research", resumed: false, runId: 6 });
    g.cancel("B");
    expect(g.live("B")).toBe(false);
  });
  test("RunGate accepts a runId-less waiting step, then the real run's events", () => {
    const g = new RunGate();
    expect(g.accept("A", { kind: "step", text: "Waiting for other jobs…" }, { kind: "research", resumed: false })).toBe(true);
    const src = { kind: "research" as const, resumed: false, runId: 9 };
    expect(g.accept("A", { kind: "step", text: "Suggesting folders…" }, src)).toBe(true);
    expect(g.accept("A", { kind: "done", folders: 1, notes: 1 }, src)).toBe(true);
  });
});

test("isNeutralMessage: Cancelled and Already researched are neutral, other text is not", () => {
  expect(isNeutralMessage(CANCELLED_MESSAGE)).toBe(true);
  expect(isNeutralMessage(ALREADY_RESEARCHED_MESSAGE)).toBe(true);
  expect(isNeutralMessage("boom")).toBe(false);
  expect(isNeutralMessage("")).toBe(false);
});
test("noticeFor: failed Cancelled -> { text: 'Cancelled', error: false }", () => {
  expect(noticeFor("A", { kind: "failed", error: CANCELLED_MESSAGE }, src, ctx)).toEqual({ text: "Cancelled", error: false });
});
test("noticeFor: failed ALREADY_RESEARCHED_MESSAGE -> neutral text, error false", () => {
  expect(ALREADY_RESEARCHED_MESSAGE).toBe("Already researched — use 'Research this folder' to run it again");
  expect(noticeFor("A", { kind: "failed", error: ALREADY_RESEARCHED_MESSAGE }, src, ctx)).toEqual({ text: ALREADY_RESEARCHED_MESSAGE, error: false });
});
