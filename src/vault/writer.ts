import { sanitiseName, uniqueName } from "../names";
import { renderNote, renderOverview, renderPdfOverview } from "./noteTemplate";
import type { KeyPoint, NoteContent, Outline, PdfOverview, SubfolderNotes } from "../types";

export interface VaultLike {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  createFolder(path: string): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  children(path: string): { name: string; isFolder: boolean }[];
}

const join = (...parts: string[]) => parts.filter((p) => p !== "").join("/");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export class VaultWriter {
  constructor(private vault: VaultLike) {}

  private created = new Set<string>();

  // Recorded before the await: the vault's create event can fire during the call.
  private async makeFolder(path: string): Promise<void> {
    this.created.add(path);
    try {
      await this.vault.createFolder(path);
    } catch (e) {
      this.created.delete(path);
      throw e;
    }
  }

  /** True (once) if the plugin itself created this folder, so it must not trigger research. */
  consumeCreated(path: string): boolean {
    return this.created.delete(path);
  }

  /** Names of everything (files and folders) directly inside a folder. */
  listNames(folder: string): string[] {
    return this.vault.children(folder).map((c) => c.name);
  }

  listSubfolders(root: string): string[] {
    return this.vault.children(root).filter((c) => c.isFolder).map((c) => c.name);
  }

  // Create a folder and any missing ancestors, matching existing ones case-insensitively.
  // Returns the resolved path (using existing casing).
  private async ensureFolder(path: string): Promise<string> {
    let current = "";
    for (const seg of path.split("/").filter((x) => x !== "")) {
      const lower = seg.toLowerCase();
      const hit = this.vault.children(current).find((c) => c.isFolder && c.name.toLowerCase() === lower);
      if (hit) current = join(current, hit.name);
      else if (this.vault.exists(join(current, seg))) current = join(current, seg);
      else {
        current = join(current, seg);
        await this.makeFolder(current);
      }
    }
    return current;
  }

  private async hasMarkedOverview(folder: string): Promise<boolean> {
    const overviews = this.vault
      .children(folder)
      .filter((c) => !c.isFolder && /^.+ - Overview( \(\d+\))?\.md$/i.test(c.name));
    for (const o of overviews) {
      const content = await this.vault.read(join(folder, o.name));
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
      if (fm && /^research-root:\s*true\s*$/m.test(fm[1])) return true;
    }
    return false;
  }

  /** True when the folder itself holds a marked overview (is already a research root). */
  isResearchRoot(path: string): Promise<boolean> {
    return this.hasMarkedOverview(path);
  }

  // Case-insensitive collision check against what already exists in a folder.
  private taken(folder: string, name: string): boolean {
    if (this.vault.exists(join(folder, name))) return true;
    const lower = name.toLowerCase();
    return this.vault.children(folder).some((c) => c.name.toLowerCase() === lower);
  }

  // Write a note with a unique filename; `used` keeps titles unique across a batch.
  private async writeUniqueNote(
    folder: string,
    rawTitle: string,
    used: Set<string>,
    render: () => string,
  ): Promise<string> {
    const title = uniqueName(sanitiseName(rawTitle), (c) => used.has(c.toLowerCase()) || this.taken(folder, `${c}.md`));
    used.add(title.toLowerCase());
    await this.vault.createFile(join(folder, `${title}.md`), render());
    return title;
  }

  async writeSubfolder(
    parent: string,
    topic: string,
    sn: SubfolderNotes,
    date: string,
  ): Promise<{ folder: string; noteTitles: string[] }> {
    await this.ensureFolder(parent);
    const name = uniqueName(sanitiseName(sn.subfolder), (c) => this.taken(parent, c));
    const folder = join(parent, name);
    await this.makeFolder(folder);
    const used = new Set<string>();
    const noteTitles: string[] = [];
    for (const note of sn.notes) {
      noteTitles.push(
        await this.writeUniqueNote(folder, note.title, used, () =>
          renderNote(note, { topic, subtopic: sn.subfolder, date }),
        ),
      );
    }
    return { folder, noteTitles };
  }

  // `parent` is the topic folder; returns the overview file path.
  async writeOverview(
    parent: string,
    outline: Outline,
    links: { subfolder: string; noteTitles: string[]; folder?: string }[],
    date: string,
  ): Promise<string> {
    await this.ensureFolder(parent);
    const base = `${sanitiseName(outline.topic)} - Overview`;
    const name = uniqueName(base, (c) => this.taken(parent, `${c}.md`));
    const path = join(parent, `${name}.md`);
    await this.vault.createFile(path, renderOverview(outline, links, date));
    return path;
  }

  /**
   * Stage 1 output. `asRoot`: `container` is created (collision-safe) next to the PDF and becomes a research
   * root holding the marked overview and one folder per key point. Otherwise `container` is the research root:
   * the overview goes to `Sources` (no marker) and each key point to its matching existing subfolder or to
   * `From PDFs/<name>`. Every key point gets an entry note, so the overview's links resolve right away.
   */
  async writePdfOverview(args: {
    container: string;
    asRoot: boolean;
    pdfName: string;
    overview: PdfOverview;
    existingSubfolders: string[];
    date: string;
  }): Promise<{ overviewPath: string; entries: { folder: string; entryPath: string; point: KeyPoint }[] }> {
    const { asRoot, pdfName, overview, date } = args;
    const stem = sanitiseName(pdfName.replace(/\.pdf$/i, ""));
    let container: string;
    if (asRoot) {
      const i = args.container.lastIndexOf("/");
      const parent = await this.ensureFolder(i >= 0 ? args.container.slice(0, i) : "");
      const name = uniqueName(sanitiseName(args.container.slice(i + 1)), (c) => this.taken(parent, c));
      container = join(parent, name);
      await this.makeFolder(container);
    } else {
      container = await this.ensureFolder(args.container);
    }
    const existing = new Map(args.existingSubfolders.map((n) => [n.toLowerCase(), n]));
    const entries: { folder: string; entryPath: string; point: KeyPoint }[] = [];
    for (const point of overview.keyPoints) {
      const name = sanitiseName(point.name);
      const match = !asRoot && point.subfolder ? existing.get(point.subfolder.toLowerCase()) : undefined;
      let folder: string;
      if (match !== undefined) {
        folder = join(container, match);
      } else {
        const parent = asRoot ? container : await this.ensureFolder(join(container, "From PDFs"));
        folder = join(parent, uniqueName(name, (c) => this.taken(parent, c)));
        await this.makeFolder(folder);
      }
      const summary = point.text.replace(/\s*\((?:pp?\.|pages?)\s*[^)]*\)\s*\.?\s*$/i, "").trim();
      const sentences = point.detail.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== "");
      const title = await this.writeUniqueNote(folder, point.name, new Set(), () =>
        renderNote(
          { title: point.name, summary, keyPoints: sentences, plainWords: point.detail },
          { topic: stem, subtopic: point.name, date, source: pdfName, pages: point.pages },
        ),
      );
      entries.push({ folder, entryPath: join(folder, `${title}.md`), point });
    }
    const target = asRoot ? container : await this.ensureFolder(join(container, "Sources"));
    const overviewName = uniqueName(`${stem} - Overview`, (c) => this.taken(target, `${c}.md`));
    const overviewPath = join(target, `${overviewName}.md`);
    const links = entries.map((e) => ({ point: e.point, target: e.entryPath.slice(0, -3) }));
    await this.vault.createFile(overviewPath, renderPdfOverview({ pdfName, overview, links, asRoot }, date));
    return { overviewPath, entries };
  }

  /** Stage 2: the researched notes of one key point, written into its existing folder (never overwriting). */
  async writeKeypointNotes(
    folder: string,
    topic: string,
    subtopic: string,
    notes: NoteContent[],
    date: string,
  ): Promise<{ noteTitles: string[] }> {
    const used = new Set<string>();
    const noteTitles: string[] = [];
    for (const note of notes) {
      noteTitles.push(await this.writeUniqueNote(folder, note.title, used, () => renderNote(note, { topic, subtopic, date })));
    }
    return { noteTitles };
  }

  async findResearchRoot(path: string): Promise<{ root: string; topic: string; parents: string[] } | null> {
    const segs = path.split("/").filter((s) => s !== "");
    const marked: string[] = [];
    // Ancestors only (the last segment is the item itself), nearest first.
    for (let i = segs.length - 1; i >= 1; i--) {
      const folder = segs.slice(0, i).join("/");
      if (await this.hasMarkedOverview(folder)) marked.push(folder);
    }
    if (marked.length === 0) return null;
    const root = marked[0];
    return { root, topic: basename(root), parents: marked.slice(1).reverse() };
  }
}
