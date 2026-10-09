import { describe, expect, test } from "vitest";
import { EDIT_SLACK_MS, MAX_RUNS, RunLog, confirmText, executeUndo, planUndo, type RunRecord, type UndoView } from "../src/undo";

/** A tiny in-memory vault: files with mtimes, folders implied by their paths plus explicit ones. */
class FakeView implements UndoView {
  files = new Map<string, number>();
  folders = new Set<string>();
  mtime(p: string) { return this.files.has(p) ? this.files.get(p)! : null; }
  children(f: string): string[] | null {
    if (!this.folders.has(f)) return null;
    const pre = f + "/";
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.folders]) if (p.startsWith(pre) && p !== f) names.add(p.slice(pre.length).split("/")[0]);
    return [...names];
  }
}

const T0 = 1_000_000;
const run = (over: Partial<RunRecord> = {}): RunRecord => ({ key: "r1", at: T0, label: "intro", root: "c#/intro", folders: [], files: [], ...over });

function world() {
  const v = new FakeView();
  v.folders.add("c#"); v.folders.add("c#/intro");
  for (const f of ["c#/intro/01 - A", "c#/intro/02 - B"]) v.folders.add(f);
  const files = ["c#/intro/01 - A/n1.md", "c#/intro/01 - A/q.md", "c#/intro/02 - B/n2.md", "c#/intro/intro - Overview.md"];
  for (const f of files) v.files.set(f, T0 + 5);
  const r = run({ folders: ["c#/intro/01 - A", "c#/intro/02 - B"], files: files.map((path) => ({ path, at: T0 })) });
  return { v, r };
}

describe("planUndo", () => {
  test("only logged items are removed; the researched folder itself and everything else stay", () => {
    const { v, r } = world();
    v.files.set("c#/notes.md", T0 + 5);           // not in the log
    v.files.set("c#/intro/mine.md", T0 + 5);       // the user's own file in the root
    const plan = planUndo(r, v);
    expect(plan.trash.map((t) => t.path).sort()).toEqual([
      "c#/intro/01 - A", "c#/intro/01 - A/n1.md", "c#/intro/01 - A/q.md", "c#/intro/02 - B", "c#/intro/02 - B/n2.md", "c#/intro/intro - Overview.md",
    ].sort());
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/notes.md");
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/mine.md");
    expect(plan.counts).toEqual({ folders: 2, notes: 4 });
  });

  test("files come before their folders, deepest folders first", () => {
    const { v, r } = world();
    v.folders.add("c#/intro/01 - A/deep");
    v.files.set("c#/intro/01 - A/deep/x.md", T0);
    const rr = { ...r, folders: [...r.folders, "c#/intro/01 - A/deep"], files: [...r.files, { path: "c#/intro/01 - A/deep/x.md", at: T0 }] };
    const order = planUndo(rr, v).trash.map((t) => t.path);
    expect(order.indexOf("c#/intro/01 - A/deep/x.md")).toBeLessThan(order.indexOf("c#/intro/01 - A/deep"));
    expect(order.indexOf("c#/intro/01 - A/deep")).toBeLessThan(order.indexOf("c#/intro/01 - A"));
    expect(order.indexOf("c#/intro/01 - A/n1.md")).toBeLessThan(order.indexOf("c#/intro/01 - A"));
  });

  test("a file edited since it was created is kept, listed as kept, and so is its folder", () => {
    const { v, r } = world();
    v.files.set("c#/intro/02 - B/n2.md", T0 + EDIT_SLACK_MS + 1);
    const plan = planUndo(r, v);
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/02 - B/n2.md");
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/02 - B");
    expect(plan.kept).toContainEqual({ path: "c#/intro/02 - B/n2.md", reason: "edited" });
    expect(plan.kept.map((k) => k.path)).toContain("c#/intro/02 - B");
    expect(plan.trash.map((t) => t.path)).toContain("c#/intro/01 - A");
  });

  test("a change within the slack (sync, indexing) does not count as an edit", () => {
    const { v, r } = world();
    v.files.set("c#/intro/02 - B/n2.md", T0 + EDIT_SLACK_MS);
    expect(planUndo(r, v).trash.map((t) => t.path)).toContain("c#/intro/02 - B/n2.md");
  });

  test("a folder that still holds a file the user added is never deleted", () => {
    const { v, r } = world();
    v.files.set("c#/intro/01 - A/my own.md", T0 + 99);
    const plan = planUndo(r, v);
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/01 - A");
    expect(plan.kept).toContainEqual({ path: "c#/intro/01 - A", reason: "not empty" });
    expect(plan.trash.map((t) => t.path)).toContain("c#/intro/01 - A/n1.md");
  });

  test("a parent of a kept folder is kept too", () => {
    const { v, r } = world();
    v.folders.add("c#/intro/02 - B/deep");
    v.files.set("c#/intro/02 - B/deep/mine.md", T0 + 9);
    const rr = { ...r, folders: [...r.folders, "c#/intro/02 - B/deep"] };
    const plan = planUndo(rr, v);
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/02 - B");
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/02 - B/deep");
  });

  test("items that are already gone are skipped quietly", () => {
    const { v, r } = world();
    v.files.delete("c#/intro/01 - A/q.md");
    const plan = planUndo(r, v);
    expect(plan.trash.map((t) => t.path)).not.toContain("c#/intro/01 - A/q.md");
    expect(plan.kept).toEqual([]);
    expect(plan.counts.notes).toBe(3);
  });

  test("the suffix rename is undone only when the folder ends up empty", () => {
    const { v, r } = world();
    const renamed = { ...r, rename: { from: "c#/intro+", to: "c#/intro" } };
    expect(planUndo(renamed, v).renameBack).toEqual({ path: "c#/intro", newPath: "c#/intro+" });

    v.files.set("c#/intro/mine.md", T0 + 9);   // the user keeps a file there
    expect(planUndo(renamed, v).renameBack).toBeUndefined();
  });

  test("no rename back when the folder is kept non-empty by an edited file", () => {
    const { v, r } = world();
    v.files.set("c#/intro/02 - B/n2.md", T0 + EDIT_SLACK_MS + 50);
    expect(planUndo({ ...r, rename: { from: "c#/intro+", to: "c#/intro" } }, v).renameBack).toBeUndefined();
  });

  test("no rename back when the original name is taken again", () => {
    const { v, r } = world();
    v.folders.add("c#/intro+");
    expect(planUndo({ ...r, rename: { from: "c#/intro+", to: "c#/intro" } }, v).renameBack).toBeUndefined();
  });
});

describe("confirm text", () => {
  test("lists the counts and the date", () => {
    const { v, r } = world();
    const at = new Date(2026, 9, 9, 12).getTime();
    const text = confirmText(planUndo({ ...r, at }, v), { ...r, at });
    expect(text).toContain("Delete 2 folders and 4 notes created on 9 Oct?");
  });
  test("singular forms, and what is kept is mentioned", () => {
    const v = new FakeView();
    v.folders.add("R"); v.folders.add("R/F"); v.files.set("R/F/a.md", T0); v.files.set("R/F/b.md", T0 + 99999);
    const r = run({ root: "R", folders: ["R/F"], files: [{ path: "R/F/a.md", at: T0 }, { path: "R/F/b.md", at: T0 }] });
    const text = confirmText(planUndo(r, v), r);
    expect(text).toContain("Delete 0 folders and 1 note");
    expect(text).toMatch(/keep 2/i);
  });
});

describe("executeUndo", () => {
  test("a failure is listed and does not stop the rest", async () => {
    const { v, r } = world();
    const plan = planUndo({ ...r, rename: { from: "c#/intro+", to: "c#/intro" } }, v);
    const calls: string[] = [];
    const res = await executeUndo(plan, {
      trash: async (p) => { if (p.endsWith("q.md")) throw new Error("locked"); calls.push(`trash ${p}`); },
      rename: async (a, b) => { calls.push(`rename ${a} -> ${b}`); },
    });
    expect(res.failed).toEqual(["c#/intro/01 - A/q.md"]);
    expect(res.trashed).toBe(plan.trash.length - 1);
    expect(calls.filter((c) => c.startsWith("trash"))).toHaveLength(plan.trash.length - 1);
  });
  test("a clean run renames the folder back last", async () => {
    const { v, r } = world();
    const plan = planUndo({ ...r, rename: { from: "c#/intro+", to: "c#/intro" } }, v);
    const calls: string[] = [];
    const res = await executeUndo(plan, { trash: async (p) => { calls.push(`trash ${p}`); }, rename: async (a, b) => { calls.push(`rename ${a} -> ${b}`); } });
    expect(res.failed).toEqual([]);
    expect(calls.at(-1)).toBe("rename c#/intro -> c#/intro+");
  });
  test("a failed trash keeps the rename from happening (the folder is not empty)", async () => {
    const { v, r } = world();
    const plan = planUndo({ ...r, rename: { from: "c#/intro+", to: "c#/intro" } }, v);
    const calls: string[] = [];
    await executeUndo(plan, { trash: async (p) => { if (p.endsWith("q.md")) throw new Error("x"); }, rename: async (a, b) => { calls.push(`${a}->${b}`); } });
    expect(calls).toEqual([]);
  });
});

describe("RunLog", () => {
  const mk = (initial: RunRecord[] = []) => {
    let t = 1000;
    const saved: RunRecord[][] = [];
    const log = new RunLog(initial, (runs) => { saved.push(runs.map((r) => ({ ...r }))); }, () => (t += 10));
    return { log, saved };
  };

  test("records the folders and files a run creates, with creation times", () => {
    const { log } = mk();
    const rec = log.begin("research:a", "A", "A");
    rec.folder("A/x");
    rec.file("A/x/n.md");
    const got = log.last()!;
    expect(got.root).toBe("A");
    expect(got.folders).toEqual(["A/x"]);
    expect(got.files).toEqual([{ path: "A/x/n.md", at: got.files[0].at }]);
    expect(got.files[0].at).toBeGreaterThan(0);
  });

  test("beginning the same key again appends to the same run (a resumed job, key point jobs of one PDF)", () => {
    const { log } = mk();
    log.begin("pdf:p:1", "p", "p").folder("p/a");
    log.begin("pdf:p:1", "p", "p").folder("p/b");
    expect(log.list()).toHaveLength(1);
    expect(log.last()!.folders).toEqual(["p/a", "p/b"]);
  });

  test("keeps only the last 20 runs", () => {
    const { log } = mk();
    for (let i = 0; i < 25; i++) log.begin(`k${i}`, `L${i}`, `R${i}`).folder(`R${i}/x`);
    expect(MAX_RUNS).toBe(20);
    expect(log.list()).toHaveLength(20);
    expect(log.list()[0].key).toBe("k5");
    expect(log.last()!.key).toBe("k24");
  });

  test("a run that created nothing is not kept", () => {
    const { log } = mk();
    log.begin("empty", "E", "E");
    expect(log.list()).toEqual([]);
  });

  test("every change is saved", () => {
    const { log, saved } = mk();
    const rec = log.begin("k", "L", "R");
    rec.folder("R/x");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)![0].folders).toEqual(["R/x"]);
  });

  test("lastFor finds the newest run of a researched folder; remove drops a run", () => {
    const { log } = mk();
    log.begin("a1", "A", "A").folder("A/x");
    log.begin("b", "B", "B").folder("B/x");
    log.begin("a2", "A", "A").folder("A/y");
    expect(log.lastFor("A")!.key).toBe("a2");
    expect(log.lastFor("Z")).toBeUndefined();
    log.remove("a2");
    expect(log.lastFor("A")!.key).toBe("a1");
  });

  test("renaming a folder in the vault keeps the log pointing at the right paths", () => {
    const { log } = mk();
    const rec = log.begin("k", "L", "A/B");
    rec.folder("A/B/x");
    rec.file("A/B/x/n.md");
    log.renamePath("A", "Z");
    const r = log.last()!;
    expect([r.root, r.folders[0], r.files[0].path]).toEqual(["Z/B", "Z/B/x", "Z/B/x/n.md"]);
    log.renamePath("Z/B/x/n.md", "Z/B/x/m.md");
    expect(log.last()!.files[0].path).toBe("Z/B/x/m.md");
  });

  test("the suffix rename is remembered by the final path and taken by the run that starts there", () => {
    const { log } = mk();
    log.noteRename("c#/intro+", "c#/intro");
    const rec = log.begin("k", "intro", "c#/intro");
    rec.folder("c#/intro/a");
    expect(log.last()!.rename).toEqual({ from: "c#/intro+", to: "c#/intro" });
    log.begin("k2", "intro", "c#/intro").folder("c#/intro/b");
    expect(log.last()!.rename).toBeUndefined(); // taken once
  });

  test("loads saved runs and ignores nothing valid", () => {
    const { log } = mk([run({ key: "old", folders: ["x"] })]);
    expect(log.last()!.key).toBe("old");
  });
});
