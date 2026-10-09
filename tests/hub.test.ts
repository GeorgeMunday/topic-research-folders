import { test, expect, beforeEach, describe } from "vitest";
import { ProgressHub } from "../src/ui/hub";
import type { HubUi, HubActions, PendingReview } from "../src/ui/hub";
import { nextRunId, resetRunIds, CANCELLED_MESSAGE } from "../src/progress";
import type { ProgressSource } from "../src/progress";
import type { Job, Outline, SubfolderSuggestion } from "../src/types";

interface RecordedNotice { text: string; error: boolean; action?: { label: string; run: () => void } }

function setup() {
  const notices: RecordedNotice[] = [];
  const statuses: string[] = [];
  const spinners: string[][] = [];
  const reviews: { outline: Outline; resolve: (v: SubfolderSuggestion[] | null) => void }[] = [];
  const ui: HubUi = {
    notice: (text, opts) => { notices.push({ text, error: !!opts?.error, action: opts?.action }); },
    setStatus: (t) => { statuses.push(t); },
    setSpinners: (p) => { spinners.push([...p]); },
    reviewModal: (outline) => new Promise((resolve) => { reviews.push({ outline, resolve }); }),
  };
  const started: [string, SubfolderSuggestion[]][] = [];
  const persisted: PendingReview[][] = [];
  const accept = { value: true };
  const missing = new Set<string>();
  const hooks: { onStart?: (p: string) => void } = {};
  const actions: HubActions = {
    startApproved: (p, a) => { started.push([p, a]); hooks.onStart?.(p); return accept.value; },
    pathExists: (p) => !missing.has(p),
    persistPending: (l) => { persisted.push(l.map((x) => ({ ...x }))); },
  };
  const hub = new ProgressHub(ui, actions);
  return {
    hub, notices, statuses, spinners, reviews, started, persisted, accept, missing, hooks,
    status: () => (statuses.length ? statuses[statuses.length - 1] : ""),
    spin: () => (spinners.length ? spinners[spinners.length - 1] : []),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const research = (runId?: number, resumed = false): ProgressSource => ({ kind: "research", resumed, runId });
const T = "Topics/Black holes";
const outline: Outline = {
  topic: "Black holes",
  summary: "s",
  subfolders: [{ name: "Anatomy", why: "a" }, { name: "Formation", why: "b" }],
};
const noConsecutiveDuplicates = (xs: unknown[]) => {
  for (let i = 1; i < xs.length; i++) expect(JSON.stringify(xs[i])).not.toBe(JSON.stringify(xs[i - 1]));
};

beforeEach(() => resetRunIds());

test("folder research success: spinner on first step, status text, done notice, spinner cleared", () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Waiting for other jobs…" }, research());
  expect(h.spin()).toEqual([T]);
  expect(h.status()).toBe("Waiting for other jobs…");
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  expect(h.status()).toBe("Researching Black holes…");
  h.hub.sink(T, { kind: "writing", index: 1, total: 2, name: "Anatomy" }, research(id, true));
  expect(h.status()).toBe("Writing folder 1 of 2: Anatomy");
  h.hub.sink(T, { kind: "itemDone", name: "Anatomy", ok: true }, research(id, true));
  h.hub.sink(T, { kind: "writing", index: 2, total: 2, name: "Formation" }, research(id, true));
  h.hub.sink(T, { kind: "itemDone", name: "Formation", ok: false, error: "bad" }, research(id, true));
  h.hub.sink(T, { kind: "itemDone", name: "Formation", ok: false, error: "bad" }, research(id, true));
  expect(h.notices).toEqual([{ text: 'Could not research "Formation": bad', error: true, action: undefined }]);
  h.hub.sink(T, { kind: "done", folders: 1, notes: 4 }, research(id, true));
  h.hub.sink(T, { kind: "done", folders: 1, notes: 4 }, research(id, true));
  expect(h.notices.map((n) => n.text)).toEqual(['Could not research "Formation": bad', "Researched Black holes: 1 folder, 4 notes"]);
  expect(h.notices[1].error).toBe(false);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
  noConsecutiveDuplicates(h.statuses);
  noConsecutiveDuplicates(h.spinners);
});

test("status shows '+n more' while several paths are active", () => {
  const h = setup();
  h.hub.sink("A", { kind: "step", text: "one" }, research(nextRunId()));
  h.hub.sink("B", { kind: "step", text: "two" }, research(nextRunId()));
  expect(h.status()).toBe("two (+1 more)");
  expect(h.spin()).toEqual(["A", "B"]);
});

test("outline failure: failed event -> one error notice, spinner cleared, no pending review", () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Searching the web…" }, research(id));
  h.hub.sink(T, { kind: "failed", error: "API error 500" }, research(id));
  h.hub.sink(T, { kind: "failed", error: "API error 500" }, research(id));
  expect(h.notices).toEqual([{ text: "Research failed for Black holes: API error 500", error: true, action: undefined }]);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
  expect(h.hub.pending()).toEqual([]);
  expect(h.persisted).toEqual([]);
});

test("user cancel via the review modal (null): neutral 'Cancelled' notice, spinner cleared, pending removed and persisted", async () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0].text).toBe("Suggestions ready for Black holes");
  expect(h.notices[0].error).toBe(false);
  expect(h.notices[0].action?.label).toBe("Review");
  expect(h.persisted).toEqual([[{ path: T, outline }]]);
  h.notices[0].action!.run();
  expect(h.reviews).toHaveLength(1);
  expect(h.reviews[0].outline).toEqual(outline);
  h.reviews[0].resolve(null);
  await flush();
  expect(h.notices[h.notices.length - 1]).toEqual({ text: "Cancelled", error: false, action: undefined });
  expect(h.hub.pending()).toEqual([]);
  expect(h.persisted[h.persisted.length - 1]).toEqual([]);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
  expect(h.started).toEqual([]);
  // Late events of the cancelled run are ignored.
  const before = h.notices.length;
  h.hub.sink(T, { kind: "failed", error: CANCELLED_MESSAGE }, research(id));
  h.hub.sink(T, { kind: "step", text: "late" }, research(id));
  expect(h.notices).toHaveLength(before);
  expect(h.spin()).toEqual([]);
});

test("an empty approval behaves like a cancel", async () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  const p = h.hub.review(T);
  h.reviews[0].resolve([]);
  await p;
  expect(h.started).toEqual([]);
  expect(h.notices[h.notices.length - 1].text).toBe("Cancelled");
  expect(h.hub.pending()).toEqual([]);
});

test("suggestions ready, then reviewed later: notice with Review action, spinner stays, review() starts the approved job", async () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  expect(h.spin()).toEqual([T]);
  expect(h.notices.map((n) => n.action?.label)).toEqual(["Review"]);
  // The outline job finished; the queue is idle but the review is still waiting.
  h.hub.onQueueChange(0, 0);
  expect(h.spin()).toEqual([T]);
  expect(h.status()).toBe("Suggestions ready (1)");
  expect(h.reviews).toHaveLength(0);
  const picked = [outline.subfolders[0]];
  const p = h.hub.review();
  expect(h.reviews).toHaveLength(1);
  h.reviews[0].resolve(picked);
  await p;
  expect(h.started).toEqual([[T, picked]]);
  expect(h.hub.pending()).toEqual([]);
  expect(h.persisted[h.persisted.length - 1]).toEqual([]);
  expect(h.spin()).toEqual([T]);
  expect(h.status()).toBe("Researching Black holes…");
  // The approved job runs under a new run id.
  const id2 = nextRunId();
  h.hub.onQueueChange(1, 0);
  h.hub.sink(T, { kind: "step", text: "Resuming research…" }, research(id2, true));
  h.hub.sink(T, { kind: "writing", index: 1, total: 1, name: "Anatomy" }, research(id2, true));
  h.hub.sink(T, { kind: "itemDone", name: "Anatomy", ok: true }, research(id2, true));
  h.hub.sink(T, { kind: "done", folders: 1, notes: 3 }, research(id2, true));
  expect(h.notices[h.notices.length - 1]).toEqual({ text: "Researched Black holes: 1 folder, 3 notes", error: false, action: undefined });
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
});

test("a repeat outline event for the same run replaces the pending review without a second notice", () => {
  const h = setup();
  const id = nextRunId();
  const outline2: Outline = { ...outline, summary: "newer" };
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  h.hub.sink(T, { kind: "outline", outline: outline2 }, research(id));
  expect(h.notices).toHaveLength(1);
  expect(h.hub.pending()).toEqual([{ path: T, outline: outline2 }]);
  expect(h.persisted[h.persisted.length - 1]).toEqual([{ path: T, outline: outline2 }]);
});

test("review twice concurrently opens one modal; review with nothing pending shows a neutral notice", async () => {
  const h = setup();
  h.hub.review();
  expect(h.reviews).toHaveLength(0);
  expect(h.notices).toEqual([{ text: "No suggestions are waiting for review.", error: false, action: undefined }]);
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  const p = h.hub.review(T);
  h.hub.review(T);
  h.hub.review();
  expect(h.reviews).toHaveLength(1);
  h.reviews[0].resolve([outline.subfolders[1]]);
  await p;
  expect(h.started).toHaveLength(1);
  // Done: a new review is possible again (nothing pending now).
  h.hub.review(T);
  expect(h.reviews).toHaveLength(1);
  expect(h.notices[h.notices.length - 1].text).toBe("No suggestions are waiting for review.");
});

test("review() without a path opens the oldest pending review", async () => {
  const h = setup();
  const o2: Outline = { ...outline, topic: "Stars" };
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  h.hub.sink("Topics/Stars", { kind: "outline", outline: o2 }, research(nextRunId()));
  h.hub.review();
  expect(h.reviews[0].outline).toEqual(outline);
  h.hub.review("Topics/Stars");
  expect(h.reviews[1].outline).toEqual(o2);
});

test("resumed job awaiting review: restorePending shows the notice and spinner, opens no modal, does not enqueue", () => {
  const h = setup();
  const jobs: Job[] = [
    { id: "research:T/B", kind: "research", path: "T/B", done: [], approved: [{ name: "x", why: "y" }] },
    { id: "pdf:T/x.pdf", kind: "pdf", path: "T/x.pdf" },
  ];
  h.hub.restorePending([{ path: T, outline }], jobs);
  expect(h.reviews).toHaveLength(0);
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0].text).toBe("Suggestions ready for Black holes");
  expect(h.notices[0].action?.label).toBe("Review");
  expect(h.persisted).toEqual([]);
  expect(h.started).toEqual([]);
  expect(h.hub.pending()).toEqual([{ path: T, outline }]);
  expect(h.spin()).toEqual(["T/B", "T/x.pdf", T]);
  expect(h.status()).toBe("Resuming x.pdf… (+1 more)");
  // The queue finishes the restored jobs without events: idle clears their activity, the review stays.
  h.hub.onQueueChange(0, 0);
  expect(h.spin()).toEqual([T]);
  expect(h.status()).toBe("Suggestions ready (1)");
  // The Review button opens the modal.
  h.notices[0].action!.run();
  expect(h.reviews).toHaveLength(1);
});

test("queue failure after flow failure shows one notice only", () => {
  const h = setup();
  const id = nextRunId();
  const job: Job = { id: `research:${T}`, kind: "research", path: T, done: [] };
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "failed", error: "disk full" }, research(id));
  h.hub.onQueueFailed(job, new Error("disk full"));
  expect(h.notices).toEqual([{ text: "Research failed for Black holes: disk full", error: true, action: undefined }]);
});

test("queue failure of a live run (gave up retrying) shows one error notice and clears the spinner", () => {
  const h = setup();
  const id = nextRunId();
  const job: Job = { id: "pdf:T/paper.pdf", kind: "pdf", path: "T/paper.pdf" };
  h.hub.sink(job.path, { kind: "step", text: "Retrying paper.pdf after a temporary error…" }, { kind: "pdf", resumed: false, runId: id });
  h.hub.onQueueFailed(job, new Error("overloaded"));
  expect(h.notices).toEqual([{ text: "Could not analyse paper.pdf: overloaded", error: true, action: undefined }]);
  expect(h.spin()).toEqual([]);
});

test("queue failure with no prior events shows the failure", () => {
  const h = setup();
  const job: Job = { id: `research:${T}`, kind: "research", path: T, done: [] };
  h.hub.onQueueFailed(job, 42);
  expect(h.notices).toEqual([{ text: "Research failed for Black holes: unexpected error", error: true, action: undefined }]);
});

test("PDF two-stage run: pdf steps + done -> overview notice; keypoint steps spin the key point folder; a failed keypoint -> one error notice; others unaffected", () => {
  const h = setup();
  const pdfPath = "Topics/Black holes/paper.pdf";
  const pid = nextRunId();
  const pdf: ProgressSource = { kind: "pdf", resumed: false, runId: pid };
  h.hub.sink(pdfPath, { kind: "step", text: "Preparing paper.pdf…" }, pdf);
  h.hub.sink(pdfPath, { kind: "step", text: "Analysing paper.pdf (chunk 1/2)…" }, pdf);
  expect(h.spin()).toEqual([pdfPath]);
  expect(h.status()).toBe("Analysing paper.pdf (chunk 1/2)…");
  h.hub.sink(pdfPath, { kind: "done", folders: 2, notes: 5 }, pdf);
  expect(h.notices).toEqual([{ text: "Overview ready for paper.pdf — researching 2 key points", error: false, action: undefined }]);
  expect(h.spin()).toEqual([]);

  const A = "Topics/Black holes/Key A";
  const B = "Topics/Black holes/Key B";
  const ka: ProgressSource = { kind: "keypoint", resumed: false, runId: nextRunId() };
  const kb: ProgressSource = { kind: "keypoint", resumed: false, runId: nextRunId() };
  h.hub.sink(A, { kind: "step", text: "Researching Key A…" }, ka);
  h.hub.sink(B, { kind: "step", text: "Researching Key B…" }, kb);
  expect(h.spin()).toEqual([A, B]);
  h.hub.sink(A, { kind: "failed", error: "boom" }, ka);
  h.hub.sink(A, { kind: "failed", error: "boom" }, ka);
  expect(h.notices.slice(1)).toEqual([{ text: 'Could not research "Key A": boom', error: true, action: undefined }]);
  expect(h.spin()).toEqual([B]);
  expect(h.status()).toBe("Researching Key B…");
  h.hub.sink(B, { kind: "done", folders: 1, notes: 3 }, kb);
  expect(h.notices).toHaveLength(2);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
});

test("onQueueChange(0,0) clears spinners and status but keeps spinners of pending reviews", () => {
  const h = setup();
  h.hub.sink("A", { kind: "outline", outline }, research(nextRunId()));
  h.hub.sink("B", { kind: "step", text: "Writing" }, research(nextRunId()));
  h.hub.onQueueChange(1, 1);
  expect(h.spin()).toEqual(["B", "A"]);
  h.hub.onQueueChange(0, 0);
  expect(h.spin()).toEqual(["A"]);
  expect(h.status()).toBe("Suggestions ready (1)");
  noConsecutiveDuplicates(h.statuses);
  noConsecutiveDuplicates(h.spinners);
});

test("onQueueChange(0,0) with nothing pending hides everything", () => {
  const h = setup();
  h.hub.sink("B", { kind: "step", text: "Writing" }, research(nextRunId()));
  h.hub.onQueueChange(0, 0);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
});

test("cancelAll clears pending reviews, spinners and status and persists the empty list", () => {
  const h = setup();
  const ida = nextRunId();
  const idb = nextRunId();
  h.hub.sink("A", { kind: "outline", outline }, research(ida));
  h.hub.sink("B", { kind: "step", text: "Writing" }, research(idb));
  h.hub.cancelAll();
  expect(h.hub.pending()).toEqual([]);
  expect(h.persisted[h.persisted.length - 1]).toEqual([]);
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
  expect(h.notices[h.notices.length - 1]).toEqual({ text: "Cancelled all research jobs.", error: false, action: undefined });
  // Late events of cancelled runs are ignored.
  const n = h.notices.length;
  h.hub.sink("B", { kind: "failed", error: CANCELLED_MESSAGE }, research(idb));
  h.hub.sink("B", { kind: "writing", index: 1, total: 1, name: "x" }, research(idb));
  expect(h.notices).toHaveLength(n);
  expect(h.spin()).toEqual([]);
});

test("cancelAll while the review modal is open: its later result starts nothing", async () => {
  const h = setup();
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  const p = h.hub.review();
  h.hub.cancelAll();
  h.reviews[0].resolve([outline.subfolders[0]]);
  await p;
  expect(h.started).toEqual([]);
  expect(h.spin()).toEqual([]);
});

test("menuItems: cancel when anything is active, queued or pending; review when pending", () => {
  const h = setup();
  expect(h.hub.menuItems()).toEqual([]);
  h.hub.onQueueChange(0, 1);
  expect(h.hub.menuItems().map((m) => m.label)).toEqual(["Cancel all research jobs"]);
  h.hub.onQueueChange(0, 0);
  expect(h.hub.menuItems()).toEqual([]);
  h.hub.sink("B", { kind: "step", text: "Writing" }, research(nextRunId()));
  expect(h.hub.menuItems().map((m) => m.label)).toEqual(["Cancel all research jobs"]);
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  const items = h.hub.menuItems();
  expect(items.map((m) => m.label)).toEqual(["Cancel all research jobs", "Review pending suggestions"]);
  items[1].run();
  expect(h.reviews).toHaveLength(1);
  items[0].run();
  expect(h.hub.pending()).toEqual([]);
  expect(h.hub.menuItems()).toEqual([]);
});

test("pending() returns a copy", () => {
  const h = setup();
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  h.hub.pending().pop();
  expect(h.hub.pending()).toHaveLength(1);
});

test("dispose ignores later events", async () => {
  const h = setup();
  h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
  const p = h.hub.review();
  const counts = () => [h.notices.length, h.statuses.length, h.spinners.length, h.persisted.length, h.reviews.length, h.started.length];
  h.hub.dispose();
  const before = counts();
  h.hub.sink("X", { kind: "step", text: "x" }, research(nextRunId()));
  h.hub.sink("X", { kind: "failed", error: "boom" }, research(nextRunId()));
  h.hub.onQueueChange(0, 0);
  h.hub.onQueueFailed({ id: "pdf:a.pdf", kind: "pdf", path: "a.pdf" }, new Error("x"));
  h.hub.review(T);
  h.hub.restorePending([{ path: "Y", outline }], []);
  h.hub.cancelAll();
  h.reviews[0].resolve([outline.subfolders[0]]);
  await p;
  expect(counts()).toEqual(before);
  expect(h.hub.menuItems()).toEqual([]);
});

test("fix I1: failure dedupe is one-shot; a later queue failure with no flow event shows a notice", () => {
  const h = setup();
  const id = nextRunId();
  const job: Job = { id: `research:${T}`, kind: "research", path: T, done: [] };
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "failed", error: "disk full" }, research(id));
  h.hub.onQueueFailed(job, new Error("disk full"));
  expect(h.notices).toHaveLength(1);
  h.hub.onQueueFailed(job, new Error("still broken"));
  expect(h.notices.map((n) => n.text)).toEqual([
    "Research failed for Black holes: disk full",
    "Research failed for Black holes: still broken",
  ]);
});

test("fix I2: the approved run's first event may be a failed with a new run id; it is accepted and noticed", async () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  const p = h.hub.review(T);
  h.reviews[0].resolve([outline.subfolders[0]]);
  await p;
  expect(h.spin()).toEqual([T]);
  const id2 = nextRunId();
  h.hub.sink(T, { kind: "failed", error: "Add your Claude API key" }, research(id2, true));
  expect(h.notices[h.notices.length - 1]).toEqual({ text: "Research failed for Black holes: Add your Claude API key", error: true, action: undefined });
  expect(h.spin()).toEqual([]);
  expect(h.status()).toBe("");
});

test("fix I2: a trailing failed(Cancelled) of the outline run gives no notice and keeps the pending spinner", () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  h.hub.sink(T, { kind: "failed", error: CANCELLED_MESSAGE }, research(id));
  expect(h.notices.map((n) => n.text)).toEqual(["Suggestions ready for Black holes"]);
  expect(h.spin()).toEqual([T]);
  expect(h.hub.pending()).toHaveLength(1);
});

test("fix I2: status after an outline event shows 'Suggestions ready (1)', not 'Choosing folders…'", () => {
  const h = setup();
  const id = nextRunId();
  h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id));
  h.hub.sink(T, { kind: "outline", outline }, research(id));
  expect(h.status()).toBe("Suggestions ready (1)");
  expect(h.statuses).not.toContain("Choosing folders…");
});

describe("fix round 1", () => {
  const BUSY = "Black holes is already being researched — review again when it finishes.";
  const GONE = "Black holes no longer exists, nothing was started.";

  test("I1: Create while a newer run of the folder is active: startApproved returns false, pending kept, newer run untouched and its outline still becomes the pending review", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    const id2 = nextRunId();
    h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(id2)); // a re-run is running
    h.accept.value = false;
    const p = h.hub.review(T);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.started).toHaveLength(1);
    expect(h.notices.at(-1)).toEqual({ text: BUSY, error: false, action: undefined });
    expect(h.hub.pending()).toEqual([{ path: T, outline }]);
    expect(h.status()).toBe("Researching Black holes…");
    const outline2: Outline = { ...outline, summary: "newer" };
    h.hub.sink(T, { kind: "outline", outline: outline2 }, research(id2));
    expect(h.hub.pending()).toEqual([{ path: T, outline: outline2 }]);
    expect(h.notices.at(-1)!.text).toBe("Suggestions ready for Black holes");
    expect(h.spin()).toEqual([T]);
  });

  test("the approved run may fail synchronously inside startApproved: its notice shows and no spinner is left behind", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    h.hooks.onStart = (p) => h.hub.sink(p, { kind: "failed", error: "Add your Claude API key" }, research(nextRunId(), true));
    const p = h.hub.review(T);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.notices.at(-1)).toEqual({ text: "Research failed for Black holes: Add your Claude API key", error: true, action: undefined });
    expect(h.spin()).toEqual([]);
    expect(h.status()).toBe("");
    expect(h.hub.pending()).toEqual([]);
  });

  test("I2: review of a folder that no longer exists opens no modal, drops the entry and its spinner, neutral notice", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    h.missing.add(T);
    await h.hub.review(T);
    expect(h.reviews).toHaveLength(0);
    expect(h.started).toEqual([]);
    expect(h.notices.at(-1)).toEqual({ text: GONE, error: false, action: undefined });
    expect(h.hub.pending()).toEqual([]);
    expect(h.persisted.at(-1)).toEqual([]);
    expect(h.spin()).toEqual([]);
  });

  test("I2: folder deleted while the modal is open: Create starts nothing", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    const p = h.hub.review(T);
    h.missing.add(T);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.started).toEqual([]);
    expect(h.notices.at(-1)).toEqual({ text: GONE, error: false, action: undefined });
    expect(h.hub.pending()).toEqual([]);
    expect(h.persisted.at(-1)).toEqual([]);
    expect(h.spin()).toEqual([]);
  });

  test("renamePending moves the entry (and entries below it), persists, the spinner follows, an open review starts the job at the new path", async () => {
    const h = setup();
    const inner = "Topics/Black holes/Anatomy";
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    h.hub.sink(inner, { kind: "outline", outline }, research(nextRunId()));
    const p = h.hub.review(T);
    const n = h.persisted.length;
    h.hub.renamePending(T, "Topics/Holes");
    expect(h.hub.pending().map((x) => x.path)).toEqual(["Topics/Holes", "Topics/Holes/Anatomy"]);
    expect(h.persisted).toHaveLength(n + 1);
    expect(h.persisted.at(-1)!.map((x) => x.path)).toEqual(["Topics/Holes", "Topics/Holes/Anatomy"]);
    expect(h.spin()).toEqual(["Topics/Holes", "Topics/Holes/Anatomy"]);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.started).toEqual([["Topics/Holes", [outline.subfolders[0]]]]);
    // Renaming an unrelated folder changes nothing and persists nothing.
    const m = h.persisted.length;
    h.hub.renamePending("Other", "Else");
    expect(h.persisted).toHaveLength(m);
  });

  test("dropPending removes the entry (and entries below it), persists, clears the spinner, shows no notice", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    h.hub.sink(`${T}/Anatomy`, { kind: "outline", outline }, research(nextRunId()));
    h.hub.sink("Stars", { kind: "outline", outline }, research(nextRunId()));
    const p = h.hub.review(T);
    const n = h.notices.length;
    h.hub.dropPending(T);
    expect(h.hub.pending().map((x) => x.path)).toEqual(["Stars"]);
    expect(h.persisted.at(-1)!.map((x) => x.path)).toEqual(["Stars"]);
    expect(h.spin()).toEqual(["Stars"]);
    expect(h.notices).toHaveLength(n);
    // The open review's result is ignored.
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.started).toEqual([]);
    const m = h.persisted.length;
    h.hub.dropPending("Nope");
    expect(h.persisted).toHaveLength(m);
  });

  test("review() never rejects: a throwing or rejecting modal or a throwing startApproved gives an error notice and the review can be retried", async () => {
    const h = setup();
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    const realModal = (h.hub as any).ui.reviewModal;
    (h.hub as any).ui.reviewModal = () => { throw new Error("no DOM"); };
    await expect(h.hub.review(T)).resolves.toBeUndefined();
    expect(h.notices.at(-1)).toMatchObject({ text: "Review problem: no DOM", error: true });
    (h.hub as any).ui.reviewModal = () => Promise.reject(new Error("closed badly"));
    await expect(h.hub.review(T)).resolves.toBeUndefined();
    expect(h.notices.at(-1)).toMatchObject({ text: "Review problem: closed badly", error: true });
    (h.hub as any).ui.reviewModal = realModal;
    h.hooks.onStart = () => { throw new Error("queue stopped"); };
    const p = h.hub.review(T);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await expect(p).resolves.toBeUndefined();
    expect(h.notices.at(-1)).toMatchObject({ text: "Review problem: queue stopped", error: true });
    expect(h.hub.pending()).toHaveLength(1);
    h.hooks.onStart = undefined;
    const q = h.hub.review(T);
    expect(h.reviews).toHaveLength(2);
    h.reviews[1].resolve(null);
    await q;
    expect(h.hub.pending()).toEqual([]);
  });
});

describe("item 2: spinner paths", () => {
  test("topic folder spins while researching and while awaiting review; a pdf file while analysed; a key point folder while its job runs; removed on done, failed, cancelled and queue idle (except pending reviews)", async () => {
    const h = setup();
    // Research: the topic folder from the first step, through the review, until the approved run ends.
    const r1 = nextRunId();
    h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(r1));
    expect(h.spin()).toEqual([T]);
    h.hub.sink(T, { kind: "outline", outline }, research(r1));
    h.hub.onQueueChange(0, 0);
    expect(h.spin()).toEqual([T]);
    const p = h.hub.review(T);
    h.reviews[0].resolve([outline.subfolders[0]]);
    await p;
    expect(h.spin()).toEqual([T]);
    const r2 = nextRunId();
    h.hub.sink(T, { kind: "writing", index: 1, total: 1, name: "Anatomy" }, research(r2, true));
    h.hub.sink(T, { kind: "done", folders: 1, notes: 3 }, research(r2, true));
    expect(h.spin()).toEqual([]);
    // PDF stage 1: the pdf file itself; removed on failed.
    const pdfPath = `${T}/paper.pdf`;
    const pdf: ProgressSource = { kind: "pdf", resumed: false, runId: nextRunId() };
    h.hub.sink(pdfPath, { kind: "step", text: "Analysing paper.pdf (chunk 1/2)…" }, pdf);
    expect(h.spin()).toEqual([pdfPath]);
    h.hub.sink(pdfPath, { kind: "failed", error: "bad" }, pdf);
    expect(h.spin()).toEqual([]);
    // Key point folders (Task 18 source kind): spin while the job runs; cancelled removes it.
    const K = `${T}/Key point`;
    const kp: ProgressSource = { kind: "keypoint", resumed: false, runId: nextRunId() };
    h.hub.sink(K, { kind: "step", text: "Researching Key point…" }, kp);
    expect(h.spin()).toEqual([K]);
    h.hub.sink(K, { kind: "failed", error: CANCELLED_MESSAGE }, kp);
    expect(h.spin()).toEqual([]);
    // Queue idle clears running work but keeps a pending review.
    h.hub.sink("A", { kind: "step", text: "x" }, research(nextRunId()));
    h.hub.sink("B", { kind: "outline", outline }, research(nextRunId()));
    expect(h.spin()).toEqual(["A", "B"]);
    h.hub.onQueueChange(0, 0);
    expect(h.spin()).toEqual(["B"]);
  });
});

describe("item 3: status text and status bar menu", () => {
  test("status text: 'Researching Black holes…' during research, 'Analysing paper.pdf (chunk 2/6)…' during a pdf run, 'Suggestions ready (N)' with only pending left, empty when idle", () => {
    const h = setup();
    const r = nextRunId();
    h.hub.sink(T, { kind: "step", text: "Researching Black holes…" }, research(r));
    expect(h.status()).toBe("Researching Black holes…");
    const pdf: ProgressSource = { kind: "pdf", resumed: false, runId: nextRunId() };
    h.hub.sink("T/paper.pdf", { kind: "step", text: "Analysing paper.pdf (chunk 2/6)…" }, pdf);
    expect(h.status()).toBe("Analysing paper.pdf (chunk 2/6)… (+1 more)");
    h.hub.sink("T/paper.pdf", { kind: "done", folders: 1, notes: 1 }, pdf);
    expect(h.status()).toBe("Researching Black holes…");
    h.hub.sink(T, { kind: "outline", outline }, research(r));
    h.hub.sink("Stars", { kind: "outline", outline }, research(nextRunId()));
    expect(h.status()).toBe("Suggestions ready (2)");
    h.hub.cancelAll();
    expect(h.status()).toBe("");
  });

  test("menuItems for idle / active / pending; the 'Cancel all' item runs the injected cancelAllJobs action (queue side) and clears the hub", async () => {
    const h = setup();
    let cancelledJobs = 0;
    (h.hub as any).actions.cancelAllJobs = () => { cancelledJobs++; };
    expect(h.hub.menuItems()).toEqual([]);
    h.hub.sink("B", { kind: "step", text: "Writing" }, research(nextRunId()));
    expect(h.hub.menuItems().map((m) => m.label)).toEqual(["Cancel all research jobs"]);
    h.hub.sink(T, { kind: "outline", outline }, research(nextRunId()));
    const items = h.hub.menuItems();
    expect(items.map((m) => m.label)).toEqual(["Cancel all research jobs", "Review pending suggestions"]);
    items[1].run();
    expect(h.reviews).toHaveLength(1);
    items[0].run();
    expect(cancelledJobs).toBe(1);
    expect(h.hub.pending()).toEqual([]);
    expect(h.spin()).toEqual([]);
    expect(h.notices.at(-1)!.text).toBe("Cancelled all research jobs.");
    expect(h.hub.menuItems()).toEqual([]);
  });
});
