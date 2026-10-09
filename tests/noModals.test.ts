import { expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import * as progress from "../src/progress";
import { ProgressHub } from "../src/ui/hub";
import type { HubUi } from "../src/ui/hub";
import { nextRunId, resetRunIds } from "../src/progress";
import type { Outline } from "../src/types";

// Guards for Task 16 item 1: the loading and progress modals are gone; the only modal the hub can open is
// the suggestion review, and only through ui.reviewModal when review() is called.

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
function files(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(path.join(root, rel)).isDirectory() ? files(rel) : [rel];
  });
}

test("the loading/progress modal modules are deleted and nothing under src imports them", () => {
  for (const f of ["src/ui/ResearchProgressModal.ts", "src/ui/progressModel.ts", "tests/progressModel.test.ts"]) {
    expect(existsSync(path.join(root, f)), f).toBe(false);
  }
  for (const f of files("src").filter((x) => x.endsWith(".ts"))) {
    expect(read(f), f).not.toMatch(/ResearchProgressModal|progressModel/);
  }
});

test("session helpers are gone from progress.ts", () => {
  expect("shouldOpenSession" in progress).toBe(false);
  expect(read("src/main.ts")).not.toMatch(/restoredPaths|shouldOpenSession|sessions/);
});

test("hub.ts opens nothing itself: no obsidian import, no modal construction, reviewModal is its only way to show one", () => {
  const src = read("src/ui/hub.ts");
  expect(src).not.toMatch(/from "obsidian"/);
  expect(src).not.toMatch(/new \w*Modal\b/);
  expect(src).not.toMatch(/\.open\(/);
  expect(src.match(/this\.ui\.reviewModal\(/g)).toHaveLength(1);
});

test("no session or modal object is created for any progress event: loading, progress and error events produce only status/spinner/notice calls", () => {
  resetRunIds();
  const calls: string[] = [];
  const ui: HubUi = {
    notice: () => { calls.push("notice"); },
    setStatus: () => { calls.push("status"); },
    setSpinners: () => { calls.push("spinners"); },
    reviewModal: () => { calls.push("reviewModal"); return Promise.resolve(null); },
  };
  const hub = new ProgressHub(ui, {
    startApproved: () => { calls.push("startApproved"); return true; },
    pathExists: () => true,
    persistPending: () => { calls.push("persist"); },
  });
  const outline: Outline = { topic: "T", summary: "s", subfolders: [{ name: "A", why: "w" }] };
  const r = { kind: "research" as const, resumed: false };
  hub.sink("T", { kind: "step", text: "Waiting for other jobs…" }, r);
  const id = nextRunId();
  hub.sink("T", { kind: "step", text: "Searching the web…" }, { ...r, runId: id });
  hub.sink("T", { kind: "outline", outline }, { ...r, runId: id });
  const id2 = nextRunId();
  hub.sink("U", { kind: "step", text: "Resuming research…" }, { kind: "research", resumed: true, runId: id2 });
  hub.sink("U", { kind: "writing", index: 1, total: 2, name: "A" }, { kind: "research", resumed: true, runId: id2 });
  hub.sink("U", { kind: "itemDone", name: "A", ok: false, error: "bad" }, { kind: "research", resumed: true, runId: id2 });
  hub.sink("U", { kind: "failed", error: "boom" }, { kind: "research", resumed: true, runId: id2 });
  hub.sink("p.pdf", { kind: "step", text: "Preparing p.pdf…" }, { kind: "pdf", resumed: false, runId: nextRunId() });
  hub.onQueueFailed({ id: "pdf:p.pdf", kind: "pdf", path: "p.pdf" }, new Error("x"));
  hub.onQueueChange(0, 0);
  hub.restorePending([{ path: "V", outline }], [{ id: "pdf:q.pdf", kind: "pdf", path: "q.pdf" }]);
  expect(new Set(calls)).toEqual(new Set(["notice", "status", "spinners", "persist"]));
  void hub.review("V");
  expect(calls.filter((c) => c === "reviewModal")).toHaveLength(1);
});

test("styles: modal-only classes removed; explorer spinner and settings classes kept", () => {
  const css = read("styles.css");
  expect(css).not.toMatch(/\.trf-spinner|\.trf-progress|\.trf-item-/);
  for (const cls of [".trf-working", ".trf-error", ".trf-muted", ".trf-spin "]) expect(css).toContain(cls);
});

test("item 3: the status bar item is styled by a class (cursor pointer), not inline display styles", () => {
  expect(read("styles.css")).toMatch(/\.trf-status\s*\{[^}]*cursor:\s*pointer/);
  const main = read("src/main.ts");
  expect(main).toContain("trf-status");
  expect(main).not.toMatch(/style\.display/);
  expect(main).toMatch(/new Menu\(\)/);
  expect(main).toMatch(/hub\.menuItems\(\)/);
});
