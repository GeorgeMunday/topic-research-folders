import { test, expect } from "vitest";
import { navSelector } from "../src/ui/explorerSpinner";

test("navSelector targets folder and file nav titles by data-path", () => {
  expect(navSelector("Black holes")).toBe('.nav-folder-title[data-path="Black holes"], .nav-file-title[data-path="Black holes"]');
});
test("navSelector escapes quotes and backslashes", () => {
  const bs = String.fromCharCode(92);
  const esc = `a${bs}"b${bs}${bs}c`;
  expect(navSelector(`a"b${bs}c`)).toBe(`.nav-folder-title[data-path="${esc}"], .nav-file-title[data-path="${esc}"]`);
});
