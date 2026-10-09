import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { addOwnRow, insideLine, keyAction, moveRow, selectApproved, setAllChecked, type SuggestionRow } from "../src/ui/selection";

const row = (name: string, checked = true): SuggestionRow => ({ suggestion: { name, why: `why ${name}` }, name, checked });
const names = (rows: SuggestionRow[]) => rows.map((r) => r.name);

describe("inside line", () => {
  test("shows the folder path the research used", () => {
    expect(insideLine("c#/intro")).toBe("Inside: c# › intro");
    expect(insideLine("Programming/Rust/basics")).toBe("Inside: Programming › Rust › basics");
    expect(insideLine("Black holes")).toBe("Inside: Black holes");
  });
});

describe("select all / none", () => {
  test("sets every row", () => {
    const rows = [row("A"), row("B", false)];
    setAllChecked(rows, false);
    expect(rows.map((r) => r.checked)).toEqual([false, false]);
    setAllChecked(rows, true);
    expect(rows.map((r) => r.checked)).toEqual([true, true]);
  });
});

describe("add your own folder", () => {
  test("adds a checked, editable row with an empty description at the bottom", () => {
    const rows = [row("A")];
    const added = addOwnRow(rows);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(added);
    expect(added).toEqual({ suggestion: { name: "", why: "" }, name: "", checked: true });
  });
  test("a row left empty is ignored on Create; a typed name is created in place", () => {
    const rows = [row("A")];
    addOwnRow(rows);
    expect(selectApproved(rows).map((r) => r.name)).toEqual(["A"]);
    addOwnRow(rows);
    rows[2].name = "My topic";
    expect(selectApproved(rows)).toEqual([{ name: "A", why: "why A" }, { name: "My topic", why: "" }]);
  });
});

describe("reorder", () => {
  test("moveRow moves one row and returns the rows in the new order", () => {
    const rows = [row("A"), row("B"), row("C")];
    expect(names(moveRow(rows, 0, 2))).toEqual(["B", "C", "A"]);
    expect(names(moveRow(rows, 2, 0))).toEqual(["C", "A", "B"]);
    expect(names(moveRow(rows, 1, 1))).toEqual(["A", "B", "C"]);
  });
  test("out of range moves (up on the first row, down on the last) change nothing", () => {
    const rows = [row("A"), row("B")];
    expect(names(moveRow(rows, 0, -1))).toEqual(["A", "B"]);
    expect(names(moveRow(rows, 1, 2))).toEqual(["A", "B"]);
  });
  test("the created folders follow the reordered rows", () => {
    const rows = moveRow([row("A"), row("B"), row("C")], 2, 0);
    expect(selectApproved(rows).map((r) => r.name)).toEqual(["C", "A", "B"]);
  });
});

describe("keyboard", () => {
  test("Enter creates unless focus is in a text field or on a button; Esc cancels", () => {
    expect(keyAction("Enter", "other")).toBe("create");
    expect(keyAction("Enter", "text")).toBeNull();
    expect(keyAction("Enter", "button")).toBeNull();
    expect(keyAction("Escape", "text")).toBe("cancel");
    expect(keyAction("Escape", "other")).toBe("cancel");
    expect(keyAction("a", "other")).toBeNull();
  });
});

describe("styles", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  test("folder name inputs fill the whole row, so long names are never cut off", () => {
    const rule = /\.trf-suggest-name\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/flex:\s*1 1 auto/);
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
  });
  test("the context line is muted", () => {
    expect(/\.trf-suggest-inside\s*\{([^}]*)\}/.exec(css)![1]).toMatch(/color:\s*var\(--text-muted\)/);
  });
});
