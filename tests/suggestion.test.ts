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

test("colliding edited names are kept for the writer to dedupe", () => {
  const out = selectApproved([
    { suggestion: s("A"), name: "Same", checked: true },
    { suggestion: s("B"), name: "Same", checked: true },
  ]);
  expect(out.map((o) => o.name)).toEqual(["Same", "Same"]);
});
