import { describe, expect, test } from "vitest";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import type { Outline, PdfExtraction, SubfolderNotes } from "../src/types";

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
    expect(v.files.get("Black holes/Anatomy/Event horizon.md")).toContain("## Questions & Answers");
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

describe("writeExtracted", () => {
  const ex: PdfExtraction = {
    summary: "paper summary",
    notes: [
      { ...note("Horizon facts"), subfolder: "anatomy", isNew: false, pages: "3-4" },
      { ...note("Jets: big"), subfolder: "Jets", isNew: true, pages: "7" },
      { ...note("Ghost"), subfolder: "Deleted", isNew: false, pages: "9" },
    ],
  };

  test("routes notes and writes source summary", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/Anatomy");
    const r = await w.writeExtracted("Black holes", "Black holes", "paper.pdf", ex, DATE);
    expect(r).toEqual([
      { subfolder: "anatomy", title: "Horizon facts", folder: "Black holes/Anatomy" },
      { subfolder: "Jets", title: "Jets - big", folder: "Black holes/From PDFs/Jets" },
      { subfolder: "Deleted", title: "Ghost", folder: "Black holes/From PDFs/Deleted" },
    ]);
    const n1 = v.files.get("Black holes/Anatomy/Horizon facts.md")!;
    expect(n1).toContain('source: "[[paper.pdf]]"');
    expect(n1).toContain('pages: "3-4"');
    expect(v.files.has("Black holes/From PDFs/Jets/Jets - big.md")).toBe(true);
    expect(v.files.has("Black holes/From PDFs/Deleted/Ghost.md")).toBe(true);
    const s = v.files.get("Black holes/Sources/paper - Summary.md")!;
    expect(s).toContain("[[Black holes/Anatomy/Horizon facts|Horizon facts]]");
    expect(s).toContain("[[Black holes/From PDFs/Jets/Jets - big|Jets - big]]");
    expect(s).toContain("[[Black holes/From PDFs/Deleted/Ghost|Ghost]]");
  });

  test("reuses existing From PDFs and Sources folders, never overwrites", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/From PDFs");
    v.folders.add("Black holes/From PDFs/Jets");
    v.folders.add("Black holes/Sources");
    v.files.set("Black holes/Sources/paper - Summary.md", "ORIGINAL");
    v.files.set("Black holes/From PDFs/Jets/Jets - big.md", "ORIGINAL2");
    const r = await w.writeExtracted("Black holes", "Black holes", "paper.pdf", { summary: "s", notes: [ex.notes[1]] }, DATE);
    expect(r).toEqual([{ subfolder: "Jets", title: "Jets - big (2)", folder: "Black holes/From PDFs/Jets" }]);
    expect(v.files.get("Black holes/Sources/paper - Summary.md")).toBe("ORIGINAL");
    expect(v.files.has("Black holes/Sources/paper - Summary (2).md")).toBe(true);
    expect(v.files.get("Black holes/From PDFs/Jets/Jets - big.md")).toBe("ORIGINAL2");
  });

  test("returned titles are unique across the batch", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/Anatomy");
    const dup: PdfExtraction = {
      summary: "s",
      notes: [
        { ...note("Same"), subfolder: "Anatomy", isNew: false, pages: "1" },
        { ...note("Same"), subfolder: "Jets", isNew: true, pages: "2" },
      ],
    };
    const r = await w.writeExtracted("Black holes", "Black holes", "p.pdf", dup, DATE);
    expect(r.map((x) => x.title)).toEqual(["Same", "Same (2)"]);
    expect(v.files.has("Black holes/From PDFs/Jets/Same (2).md")).toBe(true);
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

describe("case-insensitive folders", () => {
  test("reuses existing 'from pdfs' and 'sources' folders", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/from pdfs");
    v.folders.add("Black holes/SOURCES");
    const ex: PdfExtraction = { summary: "s", notes: [{ ...note("N"), subfolder: "Jets", isNew: true, pages: "1" }] };
    await w.writeExtracted("Black holes", "Black holes", "p.pdf", ex, DATE);
    expect(v.files.has("Black holes/from pdfs/Jets/N.md")).toBe(true);
    expect(v.files.has("Black holes/SOURCES/p - Summary.md")).toBe(true);
    expect(v.folders.has("Black holes/From PDFs")).toBe(false);
  });
  test("non-new note named 'From PDFs' or 'Sources' is not routed into them", async () => {
    const { v, w } = setup();
    v.folders.add("Black holes/From PDFs");
    v.folders.add("Black holes/Sources");
    const ex: PdfExtraction = { summary: "s", notes: [{ ...note("N"), subfolder: "Sources", isNew: false, pages: "1" }] };
    await w.writeExtracted("Black holes", "Black holes", "p.pdf", ex, DATE);
    expect(v.files.has("Black holes/Sources/N.md")).toBe(false);
    expect(v.files.has("Black holes/From PDFs/Sources/N.md")).toBe(true);
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
