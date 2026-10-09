import { describe, expect, test } from "vitest";
import { buildContext, contextToPrompt, type ContextVault } from "../src/context";

class Mem implements ContextVault {
  files = new Map<string, string>();
  folders = new Set<string>();
  folder(...paths: string[]) { for (const p of paths) this.folders.add(p); return this; }
  async read(p: string) { const c = this.files.get(p); if (c === undefined) throw new Error("no file " + p); return c; }
  children(p: string) {
    const out: { name: string; isFolder: boolean }[] = [];
    const pre = p === "" ? "" : p + "/";
    for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: false });
    for (const f of this.folders) if (f.startsWith(pre) && f !== p && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: true });
    return out;
  }
}

const withSubject = (topic: string, subject: string, lang?: string) =>
  `---\ntopic: "${topic}"\nresearch-root: true\nsubject: ${subject}\n${lang ? `codeLanguage: ${lang}\n` : ""}tags: [research]\n---\n\n> About ${topic}.\n`;

describe("subject inherited from the nearest research root", () => {
  test("reads subject and codeLanguage live from the Overview; the nearest root wins; an edit is picked up", async () => {
    const v = new Mem().folder("Programming", "Programming/Rust", "Programming/Rust/Ownership");
    v.files.set("Programming/Programming - Overview.md", withSubject("Programming", "coding"));
    v.files.set("Programming/Rust/Rust - Overview.md", withSubject("Rust", "coding", "rust"));
    let ctx = await buildContext("Programming/Rust/Ownership", v);
    expect(ctx.inherited).toEqual({ subject: "coding", codeLanguage: "rust" });
    const p = contextToPrompt(ctx);
    expect(p).toContain("subject: coding/rust");
    expect(p).toMatch(/keep it unless/i);
    v.files.set("Programming/Rust/Rust - Overview.md", withSubject("Rust", "maths"));
    ctx = await buildContext("Programming/Rust/Ownership", v);
    expect(ctx.inherited).toEqual({ subject: "maths" });
  });

  test("an unknown subject value is ignored, so the next root up is used", async () => {
    const v = new Mem().folder("A", "A/B", "A/B/C");
    v.files.set("A/A - Overview.md", withSubject("A", "history"));
    v.files.set("A/B/B - Overview.md", withSubject("B", "cooking"));
    expect((await buildContext("A/B/C", v)).inherited).toEqual({ subject: "history" });
  });

  test("no roots, no subject, no hint", async () => {
    const v = new Mem().folder("A", "A/B");
    const ctx = await buildContext("A/B", v);
    expect(ctx.inherited).toBeUndefined();
    expect(contextToPrompt(ctx)).not.toMatch(/keep it unless/i);
  });
});
