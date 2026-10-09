import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readme = readFileSync("README.md", "utf8").replace(/\r\n/g, "\n");

// A "## " line inside a code fence (the sample note in the example) is not a README heading.
const lines = readme.split("\n");
const headingAt: { title: string; line: number }[] = [];
let fence = "";
lines.forEach((l, i) => {
  const m = /^(`{3,})/.exec(l);
  if (m) fence = fence === "" ? m[1] : l.startsWith(fence) && l.trim() === fence ? "" : fence;
  else if (fence === "" && l.startsWith("## ")) headingAt.push({ title: l.slice(3), line: i });
});
const headings = headingAt.map((h) => h.title);
const section = (title: string) => {
  const i = headingAt.findIndex((h) => h.title === title);
  if (i < 0) return "";
  return lines.slice(headingAt[i].line, i + 1 < headingAt.length ? headingAt[i + 1].line : lines.length).join("\n");
};

describe("README", () => {
  test("starts with the icon, the title and a one-line description", () => {
    const lines = readme.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toMatch(/<img [^>]*src="assets\/icon\.svg"[^>]*alt="[^"]+"/);
    expect(lines[1]).toBe("# Topic Research Folders");
    expect(lines[2]).toMatch(/^[A-Z].*\.$/);
    expect(lines[2].split(". ").length).toBe(1);
    expect(lines[3]).toMatch(/^## What it does$/);
  });

  test("sections come in the requested order", () => {
    expect(headings).toEqual([
      "What it does", "How to use", "Example output", "Tips", "Settings", "Install", "API key and cost", "Privacy", "Troubleshooting", "Licence",
    ]);
  });

  test("What it does is a short list", () => {
    const items = section("What it does").split("\n").filter((l) => l.startsWith("- "));
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.length).toBeLessThanOrEqual(8);
  });

  test("How to use covers Topic+ folders, paper+.pdf files, the Review notice, nested topics and folder context", () => {
    const s = section("How to use");
    for (const needle of ["Topic+", "paper+.pdf", "paper.pdf+", "Review", "Review pending suggestions", "nested", "folder context", "subject:"]) {
      expect(s.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  test("How to use explains the explorer icons, the pop-up, numbered folders, Sources and Undo", () => {
    const s = section("How to use");
    for (const needle of ["spinner", "sparkle", "check", "warning", "click", "Select all", "Add your own folder", "drag", "01 - ", "Study path", "Number folders in learning order", "## Sources".replace("## ", ""), "Undo last research", "Undo this research", "trash", "ready to review"]) {
      expect(s.toLowerCase(), needle).toContain(needle.toLowerCase());
    }
  });

  test("nothing in the README describes the removed review Notice or a loading pop-up", () => {
    expect(readme).not.toMatch(/Review notice/i);
    expect(readme).not.toMatch(/Suggestions ready for/i);
    expect(readme).not.toMatch(/notice says/i);
    expect(readme).not.toMatch(/loading (modal|dialog|pop-?up)/i);
  });

  test("Tips shows how to name folders inside a parent topic", () => {
    const s = section("Tips");
    expect(s).toContain("c#/intro+");
    expect(s).toContain("Introduction to C#");
    expect(s.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThanOrEqual(3);
  });

  test("Example output shows the tree with Questions and Answers files and a coding note with a code example", () => {
    const s = section("Example output");
    expect(s).toContain("Ownership - Questions.md");
    expect(s).toContain("Ownership - Answers.md");
    expect(s).toContain("```rust");
    expect(s).toContain("## Code examples");
    expect(s).toContain("## Common mistakes");
    expect(s).toContain("01 - Ownership");
    expect(s).toContain("## Sources");
    expect(s).toContain("## Study path");
    expect(s).not.toContain("Questions & Answers");
  });

  test("Settings explains every setting in the tab, one line each", () => {
    const lines = section("Settings").split("\n").filter((l) => l.startsWith("- "));
    for (const name of [
      "Anthropic API key", "Model", "Use web search", "Trigger suffix", "Remove suffix", "Subfolders per topic", "Notes per subfolder",
      "Number folders in learning order", "Maximum nesting depth", "Concurrent jobs", "Retries", "Analyse PDFs", "Pages per PDF chunk", "Confirm above pages",
    ]) expect(lines.some((l) => l.includes(name)), name).toBe(true);
  });

  test("Install names the three files and the plugin folder", () => {
    const s = section("Install");
    for (const f of ["main.js", "manifest.json", "styles.css"]) expect(s).toContain(f);
    expect(s).toContain(".obsidian/plugins/topic-research-folders");
  });

  test("API key and cost, and privacy, say what is sent and what costs more", () => {
    const cost = section("API key and cost");
    expect(cost).toMatch(/your own Anthropic API key/i);
    expect(cost).toMatch(/web search/i);
    expect(cost).toMatch(/large PDFs?/i);
    expect(cost).toMatch(/confirm/i);
    const privacy = section("Privacy");
    expect(privacy).toMatch(/PDF content/i);
    expect(privacy).toMatch(/folder names/i);
    expect(privacy).toMatch(/Anthropic API/);
    expect(privacy).toMatch(/nothing else/i);
  });

  test("Troubleshooting explains the * suffix, a model that is unavailable and a stuck spinner", () => {
    const s = section("Troubleshooting");
    expect(s).toContain("`*`");
    expect(s).toMatch(/unavailable/i);
    expect(s).toMatch(/spinner/i);
    expect(s).toMatch(/sparkle/i);
    expect(s).toContain("Cancel all research jobs");
  });

  test("Licence says MIT and points at the LICENSE file", () => {
    const s = section("Licence");
    expect(s).toContain("MIT");
    expect(s).toContain("[LICENSE](LICENSE)");
  });

  test("renders cleanly: balanced code fences, no raw tabs, no trailing placeholder text", () => {
    expect((readme.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(readme).not.toMatch(/\t/);
    expect(readme).not.toMatch(/TODO|TBD|lorem/i);
  });
});
