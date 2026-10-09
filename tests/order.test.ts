import { describe, expect, test } from "vitest";
import { selectApproved, moveRow, addOwnRow, type SuggestionRow } from "../src/ui/selection";
import { outlinePrompt } from "../src/research/prompts";
import { renderOverview } from "../src/vault/noteTemplate";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { DEFAULT_SETTINGS, mergeData } from "../src/settings";
import { stripOrder } from "../src/names";
import { ProgressHub } from "../src/ui/hub";
import type { HubActions, HubUi, ReviewHooks } from "../src/ui/hub";

const row = (name: string, checked = true): SuggestionRow => ({ suggestion: { name, why: `why ${name}` }, name, checked });
const out = (rows: SuggestionRow[], number = true) => selectApproved(rows, { number }).map((r) => r.name);

describe("numbering follows the final order", () => {
  test("two-digit, zero-padded prefixes in the order shown", () => {
    expect(out([row("What is C#"), row("Variables and Types"), row("Control flow")])).toEqual(["01 - What is C sharp", "02 - Variables and Types", "03 - Control flow"]);
    const ten = Array.from({ length: 10 }, (_, i) => row(`T${i}`));
    expect(out(ten)[9]).toBe("10 - T9");
  });
  test("the user's reorder wins over the model's order", () => {
    const rows = moveRow([row("A"), row("B"), row("C")], 2, 0);
    expect(out(rows)).toEqual(["01 - C", "02 - A", "03 - B"]);
  });
  test("added folders are numbered in place and empty ones do not take a number", () => {
    const rows = [row("A"), row("B")];
    addOwnRow(rows);            // left empty
    addOwnRow(rows).name = "Mine";
    expect(out(rows)).toEqual(["01 - A", "02 - B", "03 - Mine"]);
  });
  test("unchecked rows are skipped without leaving a gap", () => {
    expect(out([row("A"), row("B", false), row("C")])).toEqual(["01 - A", "02 - C"]);
  });
  test("two rows with the same name still collide with ' (2)'", () => {
    expect(out([row("Same"), row("Same")])).toEqual(["01 - Same", "02 - Same (2)"]);
  });
  test("the setting off gives no prefix", () => {
    expect(out([row("A"), row("B")], false)).toEqual(["A", "B"]);
    expect(selectApproved([row("A")]).map((r) => r.name)).toEqual(["A"]);
  });
  test("the setting defaults to on and survives saved data", () => {
    expect(DEFAULT_SETTINGS.numberFolders).toBe(true);
    expect(mergeData({}).settings.numberFolders).toBe(true);
    expect(mergeData({ settings: { numberFolders: false } }).settings.numberFolders).toBe(false);
  });
});

describe("the prefix does not count against the name length limit", () => {
  test("a 100-character name keeps all 100 characters next to its number", () => {
    const long = "A".repeat(150);
    const [name] = out([row(long)]);
    expect(name).toBe(`01 - ${"A".repeat(100)}`);
  });
  class Mem implements VaultLike {
    files = new Map<string, string>(); folders = new Set<string>();
    exists(p: string) { return this.files.has(p) || this.folders.has(p); }
    async read(p: string) { return this.files.get(p) ?? ""; }
    async createFolder(p: string) { this.folders.add(p); }
    async createFile(p: string, c: string) { this.files.set(p, c); }
    children(p: string) {
      const pre = p === "" ? "" : p + "/";
      return [...this.folders].filter((f) => f.startsWith(pre) && !f.slice(pre.length).includes("/") && f !== p).map((f) => ({ name: f.slice(pre.length), isFolder: true }));
    }
  }
  test("the writer keeps the prefix whole, and ' (2)' still resolves collisions on disk", async () => {
    const v = new Mem();
    const w = new VaultWriter(v);
    const sub = `01 - ${"A".repeat(100)}`;
    const r1 = await w.writeSubfolder("T", "T", { subfolder: sub, notes: [{ title: "n", summary: "s", keyPoints: ["k"], plainWords: "p" }] }, "2026-10-09");
    expect(r1.folder).toBe(`T/${sub}`);
    const r2 = await w.writeSubfolder("T", "T", { subfolder: sub, notes: [{ title: "n", summary: "s", keyPoints: ["k"], plainWords: "p" }] }, "2026-10-09");
    expect(r2.folder).toBe(`T/${sub} (2)`);
  });
  test("notes and quiz files name the subfolder without its number", async () => {
    const v = new Mem();
    const w = new VaultWriter(v);
    await w.writeSubfolder("T", "T", { subfolder: "02 - Variables", notes: [{ title: "n", summary: "s", keyPoints: ["k"], plainWords: "p" }], quiz: { questions: ["q"], answers: [{ text: "a", note: "n" }] } }, "2026-10-09");
    const note = [...v.files.entries()].find(([k]) => k.endsWith("/n.md"))![1];
    expect(note).toContain('subtopic: "Variables"');
    const q = [...v.files.entries()].find(([k]) => k.endsWith("Questions.md"))!;
    expect(q[1]).toContain('subtopic: "Variables"');
    expect(stripOrder("02 - Variables")).toBe("Variables");
    expect(stripOrder("2024 - plan")).toBe("2024 - plan");
    expect(stripOrder("Variables")).toBe("Variables");
  });
});

describe("the outline asks for learning order", () => {
  test("simplest first", () => {
    const p = outlinePrompt("T", [], 6);
    expect(p).toMatch(/order a learner should study them/i);
    expect(p).toMatch(/simplest first/i);
  });
});

describe("the Overview shows a Study path in the same order", () => {
  test("an ordered list, each item the folder with its notes linked", () => {
    const md = renderOverview(
      { topic: "T", summary: "s", subfolders: [{ name: "01 - A", why: "wa" }, { name: "02 - B", why: "wb" }] },
      [{ subfolder: "01 - A", noteTitles: ["n1"], folder: "T/01 - A" }, { subfolder: "02 - B", noteTitles: ["n2"], folder: "T/02 - B" }],
      "2026-10-09",
    );
    expect(md).toContain("## Study path");
    expect(md).not.toContain("## Subfolders");
    const lines = md.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines).toEqual(["1. **01 - A**", "2. **02 - B**"]);
    expect(md.indexOf("01 - A")).toBeLessThan(md.indexOf("02 - B"));
    expect(md).toContain("[[T/01 - A/n1|n1]]");
  });
});

describe("the review gets the setting", () => {
  test("hooks.numberFolders mirrors the action", async () => {
    const seen: (ReviewHooks | undefined)[] = [];
    const ui: HubUi = { notice: () => {}, setStatus: () => {}, setSpinners: () => {}, reviewModal: (_o, h) => { seen.push(h); return new Promise(() => {}); } };
    for (const on of [true, false]) {
      const actions: HubActions = { startApproved: () => true, pathExists: () => true, persistPending: () => {}, numberFolders: () => on };
      const hub = new ProgressHub(ui, actions);
      hub.restorePending([{ path: "T", outline: { topic: "T", summary: "s", subfolders: [{ name: "A", why: "w" }] } }], []);
      void hub.review("T");
    }
    expect(seen.map((h) => h?.numberFolders)).toEqual([true, false]);
  });
});
