import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readme = readFileSync("README.md", "utf8");

describe("README", () => {
  test("names the three files to copy into the plugin folder", () => {
    for (const f of ["main.js", "manifest.json", "styles.css"]) expect(readme).toContain(f);
    expect(readme).toContain(".obsidian/plugins/topic-research-folders");
  });

  test("documents both triggers", () => {
    expect(readme).toContain("Topic+");
    expect(readme).toContain("paper+.pdf");
    expect(readme).toContain("paper.pdf+");
  });

  test("explains reviewing suggestions and cancelling", () => {
    expect(readme).toContain("Review pending suggestions");
    expect(readme).toContain("Cancel all research jobs");
  });
});
