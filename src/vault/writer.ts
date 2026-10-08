import { sanitiseName, uniqueName } from "../names";
import { renderNote, renderOverview, renderSourceSummary } from "./noteTemplate";
import type { Outline, PdfExtraction, SubfolderNotes } from "../types";

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

  listSubfolders(root: string): string[] {
    return this.vault.children(root).filter((c) => c.isFolder).map((c) => c.name);
  }

  // Create a folder and any missing ancestors; existing ones are reused.
  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const seg of path.split("/").filter((s) => s !== "")) {
      current = join(current, seg);
      if (!this.vault.exists(current)) await this.vault.createFolder(current);
    }
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
    await this.vault.createFolder(folder);
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
    links: { subfolder: string; noteTitles: string[] }[],
    date: string,
  ): Promise<string> {
    await this.ensureFolder(parent);
    const base = `${sanitiseName(outline.topic)} - Overview`;
    const name = uniqueName(base, (c) => this.taken(parent, `${c}.md`));
    const path = join(parent, `${name}.md`);
    await this.vault.createFile(path, renderOverview(outline, links, date));
    return path;
  }

  async writeExtracted(
    root: string,
    topic: string,
    pdfName: string,
    ex: PdfExtraction,
    date: string,
  ): Promise<{ subfolder: string; title: string }[]> {
    const existing = new Map(this.listSubfolders(root).map((n) => [n.toLowerCase(), n]));
    const used = new Set<string>();
    const created: { subfolder: string; title: string }[] = [];
    for (const note of ex.notes) {
      const match = note.isNew ? undefined : existing.get(note.subfolder.toLowerCase());
      let folder: string;
      if (match) {
        folder = join(root, match);
      } else {
        folder = join(root, "From PDFs", sanitiseName(note.subfolder));
        await this.ensureFolder(folder);
      }
      const title = await this.writeUniqueNote(folder, note.title, used, () =>
        renderNote(note, { topic, subtopic: note.subfolder, date, source: pdfName, pages: note.pages }),
      );
      created.push({ subfolder: note.subfolder, title });
    }

    const sourcesFolder = join(root, "Sources");
    await this.ensureFolder(sourcesFolder);
    const stem = sanitiseName(pdfName.replace(/\.pdf$/i, ""));
    const summaryName = uniqueName(`${stem} - Summary`, (c) => this.taken(sourcesFolder, `${c}.md`));
    await this.vault.createFile(
      join(sourcesFolder, `${summaryName}.md`),
      renderSourceSummary(pdfName, topic, ex.summary, created, date),
    );
    return created;
  }

  async findResearchRoot(path: string): Promise<{ root: string; topic: string; parents: string[] } | null> {
    const segs = path.split("/").filter((s) => s !== "");
    const marked: string[] = [];
    // Ancestors only (the last segment is the item itself), nearest first.
    for (let i = segs.length - 1; i >= 1; i--) {
      const folder = segs.slice(0, i).join("/");
      const overview = join(folder, `${basename(folder)} - Overview.md`);
      if (!this.vault.exists(overview)) continue;
      const content = await this.vault.read(overview);
      if (/^research-root:\s*true\s*$/m.test(content)) marked.push(folder);
    }
    if (marked.length === 0) return null;
    const root = marked[0];
    return { root, topic: basename(root), parents: marked.slice(1).reverse() };
  }
}
