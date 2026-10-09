import { sanitiseFolderName, sanitiseName, stripOrder, uniqueName } from "../names";
import { buildContext, type FolderContext } from "../context";
import { oneLine, renderNote, renderOverview, renderPdfOverview } from "./noteTemplate";
import { quizFileNames, renderAnswers, renderQuestions } from "../quiz";
import type { KeyPoint, NoteContent, Outline, PdfOverview, Quiz, SubfolderNotes } from "../types";
import type { Recorder } from "../undo";

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
  private async makeFolder(path: string, rec?: Recorder): Promise<void> {
    this.created.add(path);
    try {
      await this.vault.createFolder(path);
    } catch (e) {
      this.created.delete(path);
      throw e;
    }
    rec?.folder(path);
  }

  // Every file the plugin creates goes through here, so a run's recorder sees all of them.
  private async put(path: string, content: string, rec?: Recorder): Promise<void> {
    await this.vault.createFile(path, content);
    rec?.file(path);
  }

  /** The plugin is about to rename `path` itself (Undo): the create/rename event for it must not start research. */
  expectCreate(path: string): void { this.created.add(path); }

  /** True (once) if the plugin itself created this folder, so it must not trigger research. */
  consumeCreated(path: string): boolean {
    return this.created.delete(path);
  }

  /** What sits above and next to `path` in the vault (see context.ts). */
  context(path: string): Promise<FolderContext> {
    return buildContext(path, this.vault);
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
  private async ensureFolder(path: string, rec?: Recorder): Promise<string> {
    let current = "";
    for (const seg of path.split("/").filter((x) => x !== "")) {
      const lower = seg.toLowerCase();
      const hit = this.vault.children(current).find((c) => c.isFolder && c.name.toLowerCase() === lower);
      if (hit) current = join(current, hit.name);
      else if (this.vault.exists(join(current, seg))) current = join(current, seg);
      else {
        current = join(current, seg);
        await this.makeFolder(current, rec);
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
    rec?: Recorder,
  ): Promise<string> {
    const title = uniqueName(sanitiseName(rawTitle), (c) => used.has(c.toLowerCase()) || this.taken(folder, `${c}.md`));
    used.add(title.toLowerCase());
    await this.put(join(folder, `${title}.md`), render(), rec);
    return title;
  }

  /**
   * The "<folder> - Questions" / "- Answers" pair for the notes just written into `folder`. Answers link the note
   * they come from (full path with the title as alias, like the Overview). Nothing is written without questions.
   */
  private async writeQuiz(
    folder: string, topic: string, subtopic: string, notes: NoteContent[], titles: string[], quiz: Quiz | undefined, date: string, rec?: Recorder,
  ): Promise<void> {
    const n = quiz ? Math.min(quiz.questions.length, quiz.answers.length) : 0;
    if (!quiz || n === 0) return;
    const written = new Map<string, string>();
    notes.forEach((note, i) => { written.set(oneLine(note.title).toLowerCase(), titles[i]); });
    for (const t of titles) written.set(t.toLowerCase(), t);
    const name = basename(folder);
    let k = 1;
    let names = quizFileNames(name, k);
    while (this.taken(folder, `${names.questions}.md`) || this.taken(folder, `${names.answers}.md`)) names = quizFileNames(name, ++k);
    const answers = quiz.answers.slice(0, n).map((a) => {
      const title = a.note ? written.get(oneLine(a.note).toLowerCase()) : undefined;
      return { text: a.text, ...(title ? { link: `[[${folder}/${title}|${title}]]` } : {}) };
    });
    await this.put(join(folder, `${names.questions}.md`),
      renderQuestions({ topic, subtopic, date, file: names.questions, other: names.answers, questions: quiz.questions.slice(0, n) }), rec);
    await this.put(join(folder, `${names.answers}.md`),
      renderAnswers({ topic, subtopic, date, file: names.answers, other: names.questions, answers }), rec);
  }

  async writeSubfolder(
    parent: string,
    topic: string,
    sn: SubfolderNotes,
    date: string,
    rec?: Recorder,
  ): Promise<{ folder: string; noteTitles: string[] }> {
    await this.ensureFolder(parent, rec);
    const name = uniqueName(sanitiseFolderName(sn.subfolder), (c) => this.taken(parent, c));
    const folder = join(parent, name);
    // Notes and quiz files talk about the subfolder, not its position in the study path.
    const subtopic = stripOrder(sn.subfolder);
    await this.makeFolder(folder, rec);
    const used = new Set<string>();
    const noteTitles: string[] = [];
    for (const note of sn.notes) {
      noteTitles.push(
        await this.writeUniqueNote(folder, note.title, used, () =>
          renderNote(note, { topic, subtopic, date }), rec,
        ),
      );
    }
    await this.writeQuiz(folder, topic, subtopic, sn.notes, noteTitles, sn.quiz, date, rec);
    return { folder, noteTitles };
  }

  // `parent` is the topic folder; returns the overview file path.
  async writeOverview(
    parent: string,
    outline: Outline,
    links: { subfolder: string; noteTitles: string[]; folder?: string }[],
    date: string,
    /** File name stem; defaults to the outline's topic. Keeps the file named after the folder when the topic is a resolved one. */
    stem?: string,
    rec?: Recorder,
  ): Promise<string> {
    await this.ensureFolder(parent, rec);
    const base = `${sanitiseName(stem ?? outline.topic)} - Overview`;
    const name = uniqueName(base, (c) => this.taken(parent, `${c}.md`));
    const path = join(parent, `${name}.md`);
    await this.put(path, renderOverview(outline, links, date), rec);
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
    /** Title stem for the overview and its notes (defaults to the file name without .pdf). */
    stem?: string;
    overview: PdfOverview;
    existingSubfolders: string[];
    date: string;
    rec?: Recorder;
  }): Promise<{ overviewPath: string; entries: { folder: string; entryPath: string; point: KeyPoint }[] }> {
    const { asRoot, pdfName, overview, date, rec } = args;
    const stem = sanitiseName(args.stem ?? pdfName.replace(/\.pdf$/i, ""));
    let container: string;
    if (asRoot) {
      const i = args.container.lastIndexOf("/");
      const parent = await this.ensureFolder(i >= 0 ? args.container.slice(0, i) : "", rec);
      const name = uniqueName(sanitiseName(args.container.slice(i + 1)), (c) => this.taken(parent, c));
      container = join(parent, name);
      await this.makeFolder(container, rec);
      rec?.root(container);
    } else {
      container = await this.ensureFolder(args.container, rec);
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
        const parent = asRoot ? container : await this.ensureFolder(join(container, "From PDFs"), rec);
        folder = join(parent, uniqueName(name, (c) => this.taken(parent, c)));
        await this.makeFolder(folder, rec);
      }
      const summary = point.text.replace(/\s*\((?:pp?\.|pages?)\s*[^)]*\)\s*\.?\s*$/i, "").trim();
      const sentences = point.detail.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== "");
      const title = await this.writeUniqueNote(folder, point.name, new Set(), () =>
        renderNote(
          { title: point.name, summary, keyPoints: sentences, plainWords: point.detail },
          { topic: stem, subtopic: point.name, date, source: pdfName, pages: point.pages },
        ), rec,
      );
      entries.push({ folder, entryPath: join(folder, `${title}.md`), point });
    }
    const target = asRoot ? container : await this.ensureFolder(join(container, "Sources"), rec);
    const overviewName = uniqueName(`${stem} - Overview`, (c) => this.taken(target, `${c}.md`));
    const overviewPath = join(target, `${overviewName}.md`);
    const links = entries.map((e) => ({ point: e.point, target: e.entryPath.slice(0, -3) }));
    await this.put(overviewPath, renderPdfOverview({ pdfName, overview, links, asRoot, stem }, date), rec);
    return { overviewPath, entries };
  }

  /**
   * Stage 2: the researched notes of one key point, written into its folder (never overwriting). The folder is
   * resolved case-insensitively and recreated (recorded for consumeCreated) if the user removed it meanwhile.
   */
  async writeKeypointNotes(
    folder: string,
    topic: string,
    subtopic: string,
    notes: NoteContent[],
    date: string,
    quiz?: Quiz,
    /** The PDF the notes come from: listed under Sources instead of web pages. */
    from?: { pdf: string; pages?: string },
    rec?: Recorder,
  ): Promise<{ noteTitles: string[] }> {
    folder = await this.ensureFolder(folder, rec);
    const used = new Set<string>();
    const noteTitles: string[] = [];
    for (const note of notes) {
      noteTitles.push(await this.writeUniqueNote(folder, note.title, used, () => renderNote(note, { topic, subtopic, date, ...(from ? { source: from.pdf, ...(from.pages ? { pages: from.pages } : {}) } : {}) }), rec));
    }
    await this.writeQuiz(folder, topic, subtopic, notes, noteTitles, quiz, date, rec);
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
