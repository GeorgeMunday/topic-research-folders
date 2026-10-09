import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { DONE_MS, MarkBoard, canMove, fallbackStatus, iconFor } from "../src/ui/marks";

function board() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let changes = 0;
  const b = new MarkBoard((fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; }, () => { changes++; });
  return { b, timers, changes: () => changes, fire: () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }) };
}

describe("mark state machine", () => {
  test("working → ready → working → done, and working → failed → working", () => {
    const { b } = board();
    expect(b.set("T", "working")).toBe(true);
    expect(b.set("T", "ready")).toBe(true);
    expect(b.set("T", "working")).toBe(true);
    expect(b.set("T", "done")).toBe(true);
    expect(b.set("T", "working")).toBe(true);
    expect(b.set("T", "failed", "boom")).toBe(true);
    expect(b.get("T")).toEqual({ path: "T", state: "failed", error: "boom" });
    expect(b.set("T", "working")).toBe(true);
    expect(b.get("T")).toEqual({ path: "T", state: "working" });
  });

  test("illegal moves are ignored", () => {
    const { b } = board();
    b.set("T", "working");
    b.set("T", "ready");
    expect(b.set("T", "done")).toBe(false);
    expect(b.set("T", "failed", "x")).toBe(false);
    expect(b.get("T")!.state).toBe("ready");
    expect(canMove(undefined, "done")).toBe(false);
    expect(canMove("done", "failed")).toBe(false);
  });

  test("a restored review starts at ready; a run rejected before it started starts at failed", () => {
    const { b } = board();
    expect(b.set("A", "ready")).toBe(true);
    expect(b.set("B", "failed", "No key")).toBe(true);
  });

  test("cancelled removes the mark", () => {
    const { b } = board();
    b.set("T", "working");
    b.remove("T");
    expect(b.marks()).toEqual([]);
  });

  test("done fades out after 3 seconds and leaves nothing; a new run cancels the timer", () => {
    const { b, timers, fire } = board();
    b.set("T", "working");
    b.set("T", "done");
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(DONE_MS);
    expect(DONE_MS).toBe(3000);
    fire();
    expect(b.get("T")).toBeUndefined();

    b.set("U", "working");
    b.set("U", "done");
    b.set("U", "working");
    expect(timers[1].live).toBe(false);
    expect(b.get("U")!.state).toBe("working");
  });

  test("onChange fires only when something changed", () => {
    const { b, changes } = board();
    b.set("T", "working");
    const n = changes();
    b.set("T", "working");
    expect(changes()).toBe(n);
    b.set("T", "ready");
    expect(changes()).toBe(n + 1);
  });
});

describe("which icon and tooltip each state shows", () => {
  test("working: the spinner, not clickable", () => {
    expect(iconFor({ path: "T", state: "working" })).toMatchObject({ icon: "spinner", action: null });
  });
  test("ready: sparkles, tooltip, click reviews, one-time fade-in", () => {
    expect(iconFor({ path: "T", state: "ready" })).toEqual({ icon: "sparkles", tooltip: "Suggestions ready — click to review", action: "review", fade: "in" });
  });
  test("done: a check that fades out, not clickable", () => {
    expect(iconFor({ path: "T", state: "done" })).toMatchObject({ icon: "check", action: null, fade: "out" });
  });
  test("failed: a warning whose tooltip shows the error; click retries", () => {
    const s = iconFor({ path: "T", state: "failed", error: "Rate limited" });
    expect(s.icon).toBe("alert-triangle");
    expect(s.tooltip).toContain("Rate limited");
    expect(s.action).toBe("retry");
  });
});

test("fallback status text names the number of reviews that could not be shown in the explorer", () => {
  expect(fallbackStatus(0)).toBe("");
  expect(fallbackStatus(1)).toBe("✦ 1 ready to review");
  expect(fallbackStatus(3)).toBe("✦ 3 ready to review");
});

describe("styles", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  test("the ready sparkle is accent coloured with a one-time fade-in (no infinite animation)", () => {
    const rule = /\.trf-mark-ready\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/color:\s*var\(--interactive-accent\)/);
    expect(rule).toMatch(/animation:\s*trf-fade-in[^;]*;/);
    expect(rule).not.toMatch(/infinite/);
  });
  test("the done check fades out once; the failed icon is muted", () => {
    expect(/\.trf-mark-done\s*\{([^}]*)\}/.exec(css)![1]).toMatch(/animation:\s*trf-fade-out 3s[^;]*forwards/);
    expect(/\.trf-mark-failed\s*\{([^}]*)\}/.exec(css)![1]).toMatch(/color:\s*var\(--text-muted\)/);
  });
  test("under prefers-reduced-motion the marks do not animate", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?\n)\}/g;
    const all = [...css.matchAll(block)].map((m) => m[1]).join("\n");
    expect(all).toMatch(/\.trf-mark-ready[\s\S]*animation:\s*none/);
    expect(all).toMatch(/\.trf-mark-done[\s\S]*animation:\s*none/);
  });
  test("the icon is small and shows a pointer only when clickable", () => {
    expect(css).toMatch(/\.trf-mark svg\s*\{[^}]*width:\s*12px/);
    expect(css).toMatch(/\.trf-mark-clickable\s*\{[^}]*cursor:\s*pointer/);
  });
});
