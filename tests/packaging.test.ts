import { readFileSync, existsSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { ICON_ID, ICON_SVG_INNER } from "../src/icon";
import { ribbonItems } from "../src/ui/ribbon";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

describe("manifest.json", () => {
  test("name and description follow Obsidian's plugin guidelines", () => {
    expect(manifest.name).toBe("Topic Research Folders");
    expect(manifest.description).toBe("Add + to a folder or PDF name to research it into subfolders of easy-to-read notes, with code examples and quiz files.");
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(manifest.description.endsWith(".")).toBe(true);
    expect(pkg.description).toBe(manifest.description);
  });

  test("author fields are filled in; no placeholder remains", () => {
    expect(manifest.author).toBe("George Munday");
    expect(manifest.authorUrl).toBe("https://github.com/GeorgeMunday");
    expect(JSON.stringify(manifest)).not.toMatch(/example\.com|your-|todo|placeholder/i);
    expect(pkg.author).toBe(manifest.author);
  });
});

describe("assets/icon.svg", () => {
  const svg = readFileSync("assets/icon.svg", "utf8");
  test("is a single-colour 100x100 icon with no external references", () => {
    expect(svg).toMatch(/<svg[^>]*viewBox="0 0 100 100"/);
    expect(svg).toContain("currentColor");
    const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
    expect(withoutNamespace).not.toMatch(/https?:|href|url\(|<image|<script|<style|@import|<use/i);
    // one colour: nothing but currentColor / none / the root's own colour
    const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) expect(["currentColor", "none"]).toContain(c);
  });

  test("the content registered with addIcon is exactly the file's inner markup", () => {
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(ICON_SVG_INNER)).toBe(norm(inner));
    expect(ICON_ID).toBe("topic-research");
  });
});

describe("ribbon / status bar menu", () => {
  test("three items in order, each running its action", () => {
    const a = { review: vi.fn(), cancelAll: vi.fn(), openSettings: vi.fn() };
    const items = ribbonItems(a);
    expect(items.map((i) => i.label)).toEqual(["Review pending suggestions", "Cancel all research jobs", "Settings"]);
    items.forEach((i) => i.run());
    expect([a.review, a.cancelAll, a.openSettings].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
  });

  test("an action that throws does not escape the menu", () => {
    const items = ribbonItems({ review: () => { throw new Error("boom"); }, cancelAll: () => {}, openSettings: () => {} });
    expect(() => items[0].run()).not.toThrow();
  });
});

describe("main.ts uses the icon", () => {
  const main = readFileSync("src/main.ts", "utf8");
  test("registers it, adds the ribbon button and puts it in the status bar", () => {
    expect(main).toMatch(/addIcon\(ICON_ID, ICON_SVG_INNER\)/);
    expect(main).toMatch(/addRibbonIcon\(ICON_ID/);
    expect(main).toMatch(/setIcon\(.*ICON_ID\)/);
  });
});

describe("LICENSE", () => {
  test("is MIT, with a year and the author", () => {
    expect(existsSync("LICENSE")).toBe(true);
    const text = readFileSync("LICENSE", "utf8");
    expect(text).toMatch(/^MIT License/);
    expect(text).toMatch(/Copyright \(c\) 2026 George Munday/);
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(pkg.license).toBe("MIT");
  });
});
