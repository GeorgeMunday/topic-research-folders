import { describe, expect, test } from "vitest";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { KeyPoint, Outline, PdfOverview, SubfolderNotes } from "../src/types";

class MemVault implements VaultLike {
  files = new Map<string, string>();
  folders = new Set<string>();
  exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async read(p: string) {
    const c = this.files.get(p);
    if (c === undefined) throw new Error("no file " + p);
    return c;
  }
  async createFolder(p: string) {
    if (this.exists(p)) throw new Error("exists " + p);
    this.folders.add(p);
  }
  async createFile(p: string, c: string) {
    if (this.exists(p)) throw new Error("exists " + p);
    this.files.set(p, c);
  }
  children(p: string) {
    const out: { name: string; isFolder: boolean }[] = [];
    const pre = p === "" ? "" : p + "/";
    for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: false });
    for (const f of this.folders) if (f.startsWith(pre) && f !== p && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: true });
    return out;
  }
}

const note = (title: string) => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const sn = (subfolder: string, ...titles: string[]): SubfolderNotes => ({ subfolder, notes: titles.map(note) });
const DATE = "2026-10-08";

function setup() {
  const v = new MemVault();
  v.folders.add("Black holes");
  return { v, w: new VaultWriter(v) };
}

describe("writeSubfolder", () => {
  test("creates subfolder and one .md per note", async () => {
    const { v, w } = setup();
    const r = await w.writeSubfolder("Black holes", "Black holes", sn("Anatomy", "Event horizon", "Singularity"), DATE);
    expect(r).toEqual({ folder: "Black holes/Anatomy", noteTitles: ["Event horizon", "Singularity"] });
    expect(v.folders.has("Black holes/Anatomy")).toBe(true);
    expect(v.files.get("Black holes/Anatomy/Event horizon.md")).not.toContain("## Questions & Answers");
    expect(v.files.has("Black holes/Anatomy/Singularity.md")).toBe(true);
  });

  test("never overwrites existing folder or file", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/Anatomy");
    v.files.set("Black holes/Anatomy/Event horizon.md", "ORIGINAL");
    const r = await w.writeSubfolder("Black holes", "Black holes", sn("Anatomy", "Event horizon"), DATE);
    expect(r.folder).toBe("Black holes/Anatomy (2)");
    expect(v.files.get("Black holes/Anatomy/Event horizon.md")).toBe("ORIGINAL");
    expect(v.files.has("Black holes/Anatomy (2)/Event horizon.md")).toBe(true);
  });

  test("returns sanitised titles used as filenames", async () => {
    const { v, w } = setup();
    const r = await w.writeSubfolder("Black holes", "Black holes", sn("A/B", "What is: X?"), DATE);
    expect(r.folder).toBe("Black holes/A - B");
    expect(r.noteTitles).toEqual(["What is - X"]);
    const content = v.files.get("Black holes/A - B/What is - X.md")!;
    expect(content).toContain("# What is: X?");
  });

  test("duplicate titles get unique filenames matching returned names", async () => {
    const { v, w } = setup();
    const r = await w.writeSubfolder("Black holes", "Black holes", sn("Anatomy", "X", "X"), DATE);
    expect(r.noteTitles).toEqual(["X", "X (2)"]);
    expect(v.files.has("Black holes/Anatomy/X.md")).toBe(true);
    expect(v.files.has("Black holes/Anatomy/X (2).md")).toBe(true);
  });
});

describe("writeOverview", () => {
  const outline: Outline = { topic: "Black holes", summary: "sum", subfolders: [{ name: "Anatomy", why: "w" }] };
  test("overview path is '<Topic> - Overview.md'", async () => {
    const { v, w } = setup();
    const p = await w.writeOverview("Black holes", outline, [{ subfolder: "Anatomy", noteTitles: ["Event horizon"] }], DATE);
    expect(p).toBe("Black holes/Black holes - Overview.md");
    const c = v.files.get(p)!;
    expect(c).toContain("research-root: true");
    expect(c).toContain("[[Event horizon]]");
  });
  test("collision gets a unique name", async () => {
    const { v, w } = setup();
    v.files.set("Black holes/Black holes - Overview.md", "ORIGINAL");
    const p = await w.writeOverview("Black holes", outline, [], DATE);
    expect(p).toBe("Black holes/Black holes - Overview (2).md");
    expect(v.files.get("Black holes/Black holes - Overview.md")).toBe("ORIGINAL");
  });
});

describe("isResearchRoot", () => {
  const marked = "---\nresearch-root: true\n---\n";
  test("true only for a folder with its own marked overview", async () => {
    const { v, w } = setup();
    v.files.set("Black holes/Black holes - Overview.md", marked);
    v.folders.add("Black holes/Anatomy");
    v.files.set("Plain/Plain - Overview.md", "---\ntopic: x\n---\n");
    expect(await w.isResearchRoot("Black holes")).toBe(true);
    expect(await w.isResearchRoot("Black holes/Anatomy")).toBe(false);
    expect(await w.isResearchRoot("Plain")).toBe(false);
    expect(await w.isResearchRoot("Missing")).toBe(false);
  });
});

describe("listSubfolders", () => {
  test("returns only folder names", () => {
    const { v, w } = setup();
    v.folders.add("Black holes/Anatomy");
    v.files.set("Black holes/x.md", "");
    expect(w.listSubfolders("Black holes")).toEqual(["Anatomy"]);
  });
});

describe("findResearchRoot", () => {
  const marked = "---\nresearch-root: true\n---\n";
  test("walks up to nearest marked overview", async () => {
    const { v, w } = setup();
    v.files.set("Black holes/Black holes - Overview.md", marked);
    v.files.set("Black holes/Anatomy/Anatomy - Overview.md", marked);
    expect(await w.findResearchRoot("Black holes/Anatomy/Deep/x.pdf")).toEqual({
      root: "Black holes/Anatomy", topic: "Anatomy", parents: ["Black holes"],
    });
    expect(await w.findResearchRoot("Other/x.pdf")).toBeNull();
  });
  test("an overview without the marker is ignored", async () => {
    const { v, w } = setup();
    v.files.set("Black holes/Black holes - Overview.md", "---\ntopic: x\n---\n");
    expect(await w.findResearchRoot("Black holes/x.pdf")).toBeNull();
  });
});

describe("findResearchRoot robustness", () => {
  const marked = "---\nresearch-root: true\n---\n";
  test("renamed folder still found via inner overview", async () => {
    const { v, w } = setup();
    v.files.set("Renamed/Old name - Overview.md", marked);
    expect(await w.findResearchRoot("Renamed/Sub/x.pdf")).toEqual({ root: "Renamed", topic: "Renamed", parents: [] });
  });
  test("folder with special characters", async () => {
    const { v, w } = setup();
    v.files.set("C# basics/C basics - Overview.md", marked);
    expect((await w.findResearchRoot("C# basics/x.pdf"))?.root).toBe("C# basics");
  });
  test("numbered folder and numbered overview", async () => {
    const { v, w } = setup();
    v.files.set("Anatomy (2)/Anatomy - Overview.md", marked);
    v.files.set("Other/X - Overview (2).md", marked);
    expect((await w.findResearchRoot("Anatomy (2)/x.pdf"))?.root).toBe("Anatomy (2)");
    expect((await w.findResearchRoot("Other/x.pdf"))?.root).toBe("Other");
  });
  test("3-level parents chain outermost first", async () => {
    const { v, w } = setup();
    v.files.set("A/A - Overview.md", marked);
    v.files.set("A/B/B - Overview.md", marked);
    v.files.set("A/B/C/C - Overview.md", marked);
    expect(await w.findResearchRoot("A/B/C/x.pdf")).toEqual({ root: "A/B/C", topic: "C", parents: ["A", "A/B"] });
  });
  test("marker in body is ignored; CRLF frontmatter accepted", async () => {
    const { v, w } = setup();
    v.files.set("P/P - Overview.md", "---\ntopic: x\n---\n\nresearch-root: true\n");
    v.files.set("Q/Q - Overview.md", "---\r\nresearch-root: true\r\n---\r\n");
    expect(await w.findResearchRoot("P/x.pdf")).toBeNull();
    expect((await w.findResearchRoot("Q/x.pdf"))?.root).toBe("Q");
  });
});

describe("consumeCreated", () => {
  test("records created subfolder path and consumes it once", async () => {
    const { w } = setup();
    await w.writeSubfolder("Black holes", "Black holes", sn("C++", "x"), DATE);
    expect(w.consumeCreated("Black holes/C++")).toBe(true);
    expect(w.consumeCreated("Black holes/C++")).toBe(false);
    expect(w.consumeCreated("Black holes/other")).toBe(false);
  });

  test("records intermediate folders made by ensureFolder", async () => {
    const v = new MemVault();
    const w = new VaultWriter(v);
    await w.writeSubfolder("New/Deep", "T", sn("A", "x"), DATE);
    expect(w.consumeCreated("New")).toBe(true);
    expect(w.consumeCreated("New/Deep")).toBe(true);
    expect(w.consumeCreated("New/Deep/A")).toBe(true);
  });

  test("recorded before createFolder resolves", async () => {
    const v = new MemVault();
    const w = new VaultWriter(v);
    let during: boolean | undefined;
    const orig = v.createFolder.bind(v);
    v.createFolder = async (p: string) => { during = w.consumeCreated(p); await orig(p); };
    await w.writeSubfolder("P", "T", sn("A+", "x"), DATE);
    expect(during).toBe(true);
  });
});

// --- PDF overview (item 10, placement per item 8) ---
const point = (name: string, page: number, subfolder?: string): KeyPoint => ({
  name, text: `${name} is important (p. ${page})`, detail: `The paper explains ${name}. It gives an example.`, pages: String(page),
  ...(subfolder ? { subfolder } : {}),
});
const overview = (...points: KeyPoint[]): PdfOverview => ({ summary: "A paper about stars.", plainWords: "Stars are big hot balls.", keyPoints: points });
const FIVE = overview(point("Fusion", 2), point("Gravity", 5), point("Life cycle", 9), point("Supernovae", 14), point("Neutron stars", 20));

/** Every [[target|alias]] in the overview's Key points section, as written. */
function links(md: string): { target: string; alias: string }[] {
  const section = md.slice(md.indexOf("## Key points"), md.indexOf("## In plain words"));
  return [...section.matchAll(/\[\[([^|\]]+)\|([^\]]+)\]\]/g)].map((m) => ({ target: m[1], alias: m[2] }));
}
const bullets = (md: string) => md.slice(md.indexOf("## Key points"), md.indexOf("## In plain words")).split("\n").filter((l) => l.startsWith("- "));

describe("writePdfOverview outside a research root", () => {
  test("'<container>/<pdf> - Overview.md' has research-root true, 5 bullets with (p. N) and links, one folder + entry note per point", async () => {
    const v = new MemVault();
    v.folders.add("Inbox");
    const w = new VaultWriter(v);
    const r = await w.writePdfOverview({ container: "Inbox/paper", asRoot: true, pdfName: "paper.pdf", overview: FIVE, existingSubfolders: [], date: DATE });
    expect(r.overviewPath).toBe("Inbox/paper/paper - Overview.md");
    expect(r.entries.map((e) => e.folder)).toEqual(["Fusion", "Gravity", "Life cycle", "Supernovae", "Neutron stars"].map((n) => `Inbox/paper/${n}`));
    expect(r.entries.map((e) => e.entryPath)).toEqual(["Fusion", "Gravity", "Life cycle", "Supernovae", "Neutron stars"].map((n) => `Inbox/paper/${n}/${n}.md`));
    expect(r.entries.map((e) => e.point)).toEqual(FIVE.keyPoints);
    const md = v.files.get(r.overviewPath)!;
    expect(md).toMatch(/^---\n[\s\S]*research-root: true[\s\S]*\n---\n/);
    expect(md).toContain('source: "[[paper.pdf]]"');
    expect(md).toContain("# paper - Overview");
    expect(md).toContain("> A paper about stars.");
    expect(bullets(md)).toEqual([
      "- Fusion is important (p. 2) → [[Inbox/paper/Fusion/Fusion|Fusion]]",
      "- Gravity is important (p. 5) → [[Inbox/paper/Gravity/Gravity|Gravity]]",
      "- Life cycle is important (p. 9) → [[Inbox/paper/Life cycle/Life cycle|Life cycle]]",
      "- Supernovae is important (p. 14) → [[Inbox/paper/Supernovae/Supernovae|Supernovae]]",
      "- Neutron stars is important (p. 20) → [[Inbox/paper/Neutron stars/Neutron stars|Neutron stars]]",
    ]);
    expect(md).toContain("## In plain words\nStars are big hot balls.");
    expect(md).toContain("## My notes");
    expect(md).not.toContain("## Questions & Answers");
    // The container is now a research root of its own.
    expect(await w.isResearchRoot("Inbox/paper")).toBe(true);
    // Entry notes use the normal template, built from what the PDF says.
    const entry = v.files.get("Inbox/paper/Fusion/Fusion.md")!;
    expect(entry).toContain("# Fusion");
    expect(entry).toContain("> Fusion is important\n");
    expect(entry).toContain("- The paper explains Fusion.\n- It gives an example.");
    expect(entry).toContain('source: "[[paper.pdf]]"');
    expect(entry).toContain('pages: "2"');
    // "In plain words" is what the PDF says about this key point, not the document-level text.
    expect(entry).toContain("## In plain words\nThe paper explains Fusion. It gives an example.\n");
    expect(entry).not.toContain("Stars are big hot balls.");
    expect(entry).not.toContain("## Questions & Answers");
    expect(entry).not.toContain("research-root");
  });

  test("container collision -> 'paper (2)'; folders created are recorded for consumeCreated", async () => {
    const v = new MemVault();
    v.folders.add("Inbox");
    v.folders.add("Inbox/paper");
    v.files.set("Inbox/paper/old.md", "ORIGINAL");
    const w = new VaultWriter(v);
    const r = await w.writePdfOverview({ container: "Inbox/paper", asRoot: true, pdfName: "paper.pdf", overview: overview(point("Fusion", 2)), existingSubfolders: [], date: DATE });
    expect(r.overviewPath).toBe("Inbox/paper (2)/paper - Overview.md");
    expect(r.entries[0].entryPath).toBe("Inbox/paper (2)/Fusion/Fusion.md");
    expect(v.files.get("Inbox/paper/old.md")).toBe("ORIGINAL");
    expect(w.consumeCreated("Inbox/paper (2)")).toBe(true);
    expect(w.consumeCreated("Inbox/paper (2)/Fusion")).toBe(true);
    expect(w.consumeCreated("Inbox/paper")).toBe(false);
  });

  test("thin document: 2 key points -> exactly 2 bullets and 2 folders", async () => {
    const v = new MemVault();
    const w = new VaultWriter(v);
    const r = await w.writePdfOverview({ container: "paper", asRoot: true, pdfName: "paper.pdf", overview: overview(point("Fusion", 2), point("Gravity", 3)), existingSubfolders: [], date: DATE });
    expect(bullets(v.files.get(r.overviewPath)!)).toHaveLength(2);
    expect(r.entries).toHaveLength(2);
    expect(w.listSubfolders("paper")).toEqual(["Fusion", "Gravity"]);
  });

  test("zero key points -> overview with an empty Key points section and no folders", async () => {
    const v = new MemVault();
    const w = new VaultWriter(v);
    const r = await w.writePdfOverview({ container: "paper", asRoot: true, pdfName: "paper.pdf", overview: overview(), existingSubfolders: [], date: DATE });
    expect(r.entries).toEqual([]);
    const md = v.files.get(r.overviewPath)!;
    expect(md).toContain("## Key points\n\n## In plain words");
    expect(w.listSubfolders("paper")).toEqual([]);
  });

  test("titles and paths are sanitised ('What is: X?'), links still resolve", async () => {
    const v = new MemVault();
    const w = new VaultWriter(v);
    const r = await w.writePdfOverview({ container: "paper", asRoot: true, pdfName: "paper.pdf", overview: overview(point("What is: X?", 4)), existingSubfolders: [], date: DATE });
    expect(r.entries[0].folder).toBe("paper/What is - X");
    expect(r.entries[0].entryPath).toBe("paper/What is - X/What is - X.md");
    expect(links(v.files.get(r.overviewPath)!)).toEqual([{ target: "paper/What is - X/What is - X", alias: "What is: X?" }]);
  });
});

describe("writePdfOverview inside a research root", () => {
  function rootVault() {
    const v = new MemVault();
    v.folders.add("Stars");
    v.folders.add("Stars/Anatomy");
    v.folders.add("Stars/History");
    v.files.set("Stars/Stars - Overview.md", "---\nresearch-root: true\n---\n");
    return { v, w: new VaultWriter(v) };
  }

  test("overview under Sources without the marker; a matching subfolder gets the point, others go to From PDFs/<name>", async () => {
    const { v, w } = rootVault();
    const ov = overview(point("Core", 2, "anatomy"), point("Discovery", 5, "History"), point("Jets", 7), point("Ghost", 8, "Deleted"));
    const r = await w.writePdfOverview({ container: "Stars", asRoot: false, pdfName: "paper.pdf", overview: ov, existingSubfolders: ["Anatomy", "History"], date: DATE });
    expect(r.overviewPath).toBe("Stars/Sources/paper - Overview.md");
    const md = v.files.get(r.overviewPath)!;
    expect(md).not.toContain("research-root");
    expect(r.entries.map((e) => e.folder)).toEqual(["Stars/Anatomy", "Stars/History", "Stars/From PDFs/Jets", "Stars/From PDFs/Ghost"]);
    expect(r.entries.map((e) => e.entryPath)).toEqual(["Stars/Anatomy/Core.md", "Stars/History/Discovery.md", "Stars/From PDFs/Jets/Jets.md", "Stars/From PDFs/Ghost/Ghost.md"]);
    // Still the same root (Sources holds no marker).
    expect((await w.findResearchRoot("Stars/Sources/paper - Overview.md"))?.root).toBe("Stars");
  });

  test("reuses Sources and From PDFs case-insensitively; From PDFs/<name> and entry notes are made unique, nothing overwritten", async () => {
    const { v, w } = rootVault();
    v.folders.add("Stars/sources");
    v.files.set("Stars/sources/paper - Overview.md", "ORIGINAL");
    v.folders.add("Stars/from pdfs");
    v.folders.add("Stars/from pdfs/Jets");
    v.files.set("Stars/Anatomy/Core.md", "ORIGINAL2");
    const r = await w.writePdfOverview({ container: "Stars", asRoot: false, pdfName: "paper.pdf", overview: overview(point("Core", 2, "Anatomy"), point("Jets", 7)), existingSubfolders: ["Anatomy", "History"], date: DATE });
    expect(r.overviewPath).toBe("Stars/sources/paper - Overview (2).md");
    expect(v.files.get("Stars/sources/paper - Overview.md")).toBe("ORIGINAL");
    expect(r.entries.map((e) => e.entryPath)).toEqual(["Stars/Anatomy/Core (2).md", "Stars/from pdfs/Jets (2)/Jets.md"]);
    expect(v.files.get("Stars/Anatomy/Core.md")).toBe("ORIGINAL2");
    expect(w.consumeCreated("Stars/from pdfs/Jets (2)")).toBe(true);
    expect(w.consumeCreated("Stars/Anatomy")).toBe(false);
  });

  test("overview links resolve: every [[target]] equals a created entry note path", async () => {
    const { v, w } = rootVault();
    const ov = overview(point("Core", 2, "Anatomy"), point("Jets", 7), point("Jets", 9), point("What is: X?", 4));
    const r = await w.writePdfOverview({ container: "Stars", asRoot: false, pdfName: "paper.pdf", overview: ov, existingSubfolders: ["Anatomy", "History"], date: DATE });
    const found = links(v.files.get(r.overviewPath)!);
    expect(found).toHaveLength(4);
    expect(found.map((l) => `${l.target}.md`)).toEqual(r.entries.map((e) => e.entryPath));
    for (const l of found) expect(v.files.has(`${l.target}.md`)).toBe(true);
    expect(found.map((l) => l.alias)).toEqual(["Core", "Jets", "Jets", "What is: X?"]);
  });
});

describe("writeKeypointNotes", () => {
  test("writes the notes into the existing folder with unique names, never overwriting", async () => {
    const v = new MemVault();
    v.folders.add("paper");
    v.folders.add("paper/Fusion");
    v.files.set("paper/Fusion/Fusion.md", "ENTRY");
    const w = new VaultWriter(v);
    const r = await w.writeKeypointNotes("paper/Fusion", "paper", "Fusion", [note("Fusion"), note("How: stars burn"), note("How: stars burn")], DATE);
    expect(r.noteTitles).toEqual(["Fusion (2)", "How - stars burn", "How - stars burn (2)"]);
    expect(v.files.get("paper/Fusion/Fusion.md")).toBe("ENTRY");
    const md = v.files.get("paper/Fusion/How - stars burn.md")!;
    expect(md).toContain('topic: "paper"\nsubtopic: "Fusion"');
    expect(md).not.toContain("## Questions & Answers");
    expect([...v.folders]).toEqual(["paper", "paper/Fusion"]);
  });
});

test("writeKeypointNotes recreates a missing folder (recorded for consumeCreated) and reuses an existing one case-insensitively", async () => {
  const v = new MemVault();
  v.folders.add("paper");
  v.folders.add("paper/Fusion");
  const w = new VaultWriter(v);
  await w.writeKeypointNotes("paper/Gone", "paper", "Gone", [note("A")], DATE);
  expect(v.folders.has("paper/Gone")).toBe(true);
  expect(w.consumeCreated("paper/Gone")).toBe(true);
  await w.writeKeypointNotes("paper/fusion", "paper", "Fusion", [note("B")], DATE);
  expect(v.files.has("paper/Fusion/B.md")).toBe(true);
  expect(v.folders.has("paper/fusion")).toBe(false);
});
