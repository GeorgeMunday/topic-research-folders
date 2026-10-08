import { test, expect } from "vitest";
import { sanitiseName, uniqueName } from "../src/names";

test("removes illegal chars", () => {
  expect(sanitiseName("C++ / Templates")).toBe("C++ - Templates");
  expect(sanitiseName("What is: X?")).toBe("What is - X");
  expect(sanitiseName('  a*b"c<d>e|f  ')).toBe("a b c d e f");
  expect(sanitiseName("...hidden")).toBe("hidden");
  expect(sanitiseName("???")).toBe("Untitled");
  expect(sanitiseName("x".repeat(200)).length).toBe(100);
});
test("uniqueName appends counter", () => {
  const taken = new Set(["Basics", "Basics (2)"]);
  expect(uniqueName("Basics", n => taken.has(n))).toBe("Basics (3)");
});
