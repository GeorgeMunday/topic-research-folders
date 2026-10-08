import { expect, test } from "vitest";
import { selectApproved } from "../src/ui/selection";

const s = (name: string) => ({ name, why: "because" });

test("returns only checked rows", () => {
  const out = selectApproved([
    { suggestion: s("A"), name: "A", checked: true },
    { suggestion: s("B"), name: "B", checked: false },
  ]);
  expect(out).toEqual([{ name: "A", why: "because" }]);
});

test("uses the edited name, sanitised", () => {
  const out = selectApproved([{ suggestion: s("A"), name: "New: name?", checked: true }]);
  expect(out[0].name).toBe("New - name");
  expect(out[0].why).toBe("because");
});

test("empty edited name falls back to the original", () => {
  const out = selectApproved([{ suggestion: s("Original"), name: "   ", checked: true }]);
  expect(out[0].name).toBe("Original");
});

test("none checked gives empty", () => {
  expect(selectApproved([{ suggestion: s("A"), name: "A", checked: false }])).toEqual([]);
});

test("colliding names are suffixed so none is skipped by the done-list", () => {
  const out = selectApproved([
    { suggestion: s("A"), name: "Same", checked: true },
    { suggestion: s("B"), name: "Same", checked: true },
    { suggestion: s("C"), name: "same", checked: true },
    { suggestion: s("D"), name: "SAME", checked: false },
  ]);
  expect(out.map((o) => o.name)).toEqual(["Same", "Same (2)", "same (3)"]);
});

test("names that collide only after sanitising are deduped", () => {
  const out = selectApproved([
    { suggestion: s("A"), name: "a/b", checked: true },
    { suggestion: s("B"), name: "a:b", checked: true },
  ]);
  expect(out.map((o) => o.name)).toEqual(["a - b", "a - b (2)"]);
});

test("reserved folder names get a notes suffix", () => {
  const out = selectApproved([
    { suggestion: s("A"), name: "Sources", checked: true },
    { suggestion: s("B"), name: "from pdfs", checked: true },
    { suggestion: s("C"), name: "Sources notes", checked: true },
  ]);
  expect(out.map((o) => o.name)).toEqual(["Sources notes", "from pdfs notes", "Sources notes (2)"]);
});
