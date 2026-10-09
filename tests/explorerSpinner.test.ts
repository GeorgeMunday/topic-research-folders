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

import { readFileSync } from "fs";
import path from "path";

/** Bodies of every `@media (prefers-reduced-motion: reduce) { … }` block (brace-matched). */
function reducedMotionBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

test("styles: the explorer spinner is a rotating ring, and under prefers-reduced-motion a static dot (content '•', no animation, no ring)", () => {
  const css = readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");
  // Normal state: a ring that rotates.
  const normal = /\.nav-file-title\.trf-working > \.nav-file-title-content::after\s*\{([^}]*)\}/.exec(css.replace(reducedMotionBlocks(css).join(""), ""));
  expect(normal).not.toBeNull();
  // Beside the name (inside the title text element), not pushed to the far edge of the row.
  expect(normal![1]).not.toMatch(/margin-left:\s*auto/);
  expect(normal![1]).toMatch(/animation:\s*trf-rotate/);
  expect(normal![1]).toMatch(/border:\s*2px solid/);
  expect(normal![1]).toMatch(/border-radius:\s*50%/);
  // Reduced motion: a static dot.
  const block = reducedMotionBlocks(css).find((b) => b.includes(".trf-working > "));
  expect(block, "a reduced-motion block for .trf-working::after").toBeDefined();
  const rule = /\.trf-working > [\w.-]+::after\s*\{([^}]*)\}/.exec(block!)![1];
  expect(rule).toMatch(/content:\s*"•"/);
  expect(rule).toMatch(/animation:\s*none/);
  expect(rule).toMatch(/border:\s*none/);
  expect(rule).not.toMatch(/border-(top-)?color|border-radius/);
  expect(css).not.toMatch(/content:\s*"…"/);
});
