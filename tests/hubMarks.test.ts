import { beforeEach, describe, expect, test } from "vitest";
import { ProgressHub } from "../src/ui/hub";
import type { HubActions, HubUi } from "../src/ui/hub";
import type { Mark } from "../src/ui/marks";
import { nextRunId, resetRunIds } from "../src/progress";
import type { ProgressSource } from "../src/progress";
import type { Outline } from "../src/types";

const outline: Outline = { topic: "T", summary: "s", subfolders: [{ name: "A", why: "w" }] };

function setup() {
  const notices: string[] = [];
  const marks: Mark[][] = [];
  const spinners: string[][] = [];
  const statuses: string[] = [];
  const retried: [string, string][] = [];
  const timers: { fn: () => void; live: boolean }[] = [];
  const reviews: { resolve: (v: any) => void }[] = [];
  const ui: HubUi = {
    notice: (t) => { notices.push(t); },
    setStatus: (t) => { statuses.push(t); },
    setSpinners: (p) => { spinners.push([...p]); },
    setMarks: (m) => { marks.push(m.map((x) => ({ ...x }))); },
    reviewModal: () => new Promise((resolve) => { reviews.push({ resolve }); }),
  };
  const actions: HubActions = {
    startApproved: () => true,
    pathExists: () => true,
    persistPending: () => {},
    retry: (p, k) => { retried.push([p, k]); },
  };
  const hub = new ProgressHub(ui, actions, (fn) => { const t = { fn, live: true }; timers.push(t); return () => { t.live = false; }; });
  return {
    hub, notices, retried, reviews, statuses,
    marks: () => marks.at(-1) ?? [],
    spin: () => spinners.at(-1) ?? [],
    fire: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }),
  };
}
const research = (runId: number): ProgressSource => ({ kind: "research", resumed: false, runId });
const pdf = (runId: number): ProgressSource => ({ kind: "pdf", resumed: false, runId });

beforeEach(() => resetRunIds());

describe("explorer marks from hub events", () => {
  test("working → ready: the spinner turns into a sparkle, and no Notice appears", () => {
    const h = setup();
    const id = nextRunId();
    h.hub.sink("T", { kind: "step", text: "Researching T…" }, research(id));
    expect(h.spin()).toEqual(["T"]);
    h.hub.sink("T", { kind: "outline", outline }, research(id));
    expect(h.spin()).toEqual([]);
    expect(h.marks()).toEqual([{ path: "T", state: "ready" }]);
    expect(h.notices).toEqual([]);
    expect(h.statuses.every((s) => !s.startsWith("Suggestions ready"))).toBe(true);
  });

  test("a restored pending review shows the sparkle, with no Notice", () => {
    const h = setup();
    h.hub.restorePending([{ path: "T", outline }], []);
    expect(h.marks()).toEqual([{ path: "T", state: "ready" }]);
    expect(h.notices).toEqual([]);
  });

  test("approved run: sparkle → working → check, and the check clears itself after the timer", async () => {
    const h = setup();
    h.hub.restorePending([{ path: "T", outline }], []);
    const p = h.hub.review("T");
    h.reviews[0].resolve([{ name: "A", why: "w" }]);
    await p;
    const id = nextRunId();
    h.hub.sink("T", { kind: "step", text: "Researching T…" }, research(id));
    expect(h.marks()).toEqual([]);
    expect(h.spin()).toEqual(["T"]);
    h.hub.sink("T", { kind: "done", folders: 1, notes: 2 }, research(id));
    expect(h.marks()).toEqual([{ path: "T", state: "done" }]);
    expect(h.spin()).toEqual([]);
    h.fire();
    expect(h.marks()).toEqual([]);
  });

  test("a failed run shows the warning with the error; activating it retries; the retry clears it", () => {
    const h = setup();
    const id = nextRunId();
    h.hub.sink("paper.pdf", { kind: "step", text: "Analysing…" }, pdf(id));
    h.hub.sink("paper.pdf", { kind: "failed", error: "Rate limited" }, pdf(id));
    expect(h.marks()).toEqual([{ path: "paper.pdf", state: "failed", error: "Rate limited" }]);
    h.hub.activate("paper.pdf");
    expect(h.retried).toEqual([["paper.pdf", "pdf"]]);
    h.hub.sink("paper.pdf", { kind: "step", text: "Analysing…" }, pdf(nextRunId()));
    expect(h.marks()).toEqual([]);
  });

  test("cancelled: no icon at all", () => {
    const h = setup();
    const id = nextRunId();
    h.hub.sink("T", { kind: "step", text: "x" }, research(id));
    h.hub.sink("T", { kind: "failed", error: "Cancelled" }, research(id));
    expect(h.marks()).toEqual([]);
    expect(h.spin()).toEqual([]);
  });

  test("Cancel all removes ready marks too", () => {
    const h = setup();
    h.hub.restorePending([{ path: "T", outline }], []);
    h.hub.cancelAll();
    expect(h.marks()).toEqual([]);
  });

  test("activating a ready mark opens its review; menu items match the state", async () => {
    const h = setup();
    h.hub.restorePending([{ path: "T", outline }], []);
    expect(h.hub.menuFor("T").map((m) => m.label)).toEqual(["Review suggestions"]);
    expect(h.hub.menuFor("Other")).toEqual([]);
    h.hub.activate("T");
    expect(h.reviews).toHaveLength(1);

    const id = nextRunId();
    h.hub.sink("P", { kind: "step", text: "x" }, research(id));
    h.hub.sink("P", { kind: "failed", error: "boom" }, research(id));
    expect(h.hub.menuFor("P").map((m) => m.label)).toEqual(["Retry research"]);
  });

  test("the ready mark follows a renamed folder", () => {
    const h = setup();
    h.hub.restorePending([{ path: "T", outline }], []);
    h.hub.renamePending("T", "U");
    expect(h.marks()).toEqual([{ path: "U", state: "ready" }]);
  });
});
