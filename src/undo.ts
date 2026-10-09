// Pure: what each research run created, and what "Undo" may remove. No `obsidian` import.

/** What a writer reports while it creates things. */
export interface Recorder {
  folder(path: string): void;
  file(path: string): void;
  /** The researched folder, when it is only known after it was created (collision-safe name). */
  root(path: string): void;
}

export interface RunRecord {
  /** Identifies the run: a resumed job or the key point jobs of one PDF append to the same record. */
  key: string;
  /** ms epoch when the run started. */
  at: number;
  /** The topic or PDF name, for messages. */
  label: string;
  /** The researched folder (or the folder made next to a PDF). */
  root: string;
  folders: string[];
  files: { path: string; at: number }[];
  /** The trigger-suffix rename of the root folder (`from` → `to`). */
  rename?: { from: string; to: string };
}

export const MAX_RUNS = 20;
/** A file whose mtime is within this of its creation counts as untouched (sync and indexing can bump it). */
export const EDIT_SLACK_MS = 2000;
const MAX_RENAMES = 50;

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const move = (p: string, from: string, to: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);

export class RunLog {
  private runs: RunRecord[];
  private renames: Record<string, string>;

  constructor(
    initial: RunRecord[],
    private onChange: (runs: RunRecord[], renames: Record<string, string>) => void,
    private now: () => number = Date.now,
    renames: Record<string, string> = {},
  ) {
    this.runs = initial.map((r) => ({ ...r, folders: [...r.folders], files: r.files.map((f) => ({ ...f })) }));
    this.renames = { ...renames };
  }

  list(): RunRecord[] { return this.runs.map((r) => ({ ...r })); }
  renamesMap(): Record<string, string> { return { ...this.renames }; }
  last(): RunRecord | undefined { return this.runs.length > 0 ? this.runs[this.runs.length - 1] : undefined; }
  lastFor(root: string): RunRecord | undefined { return [...this.runs].reverse().find((r) => r.root === root); }

  /** Remembers that the folder now at `to` was renamed from `from` (the suffix), for the run that starts there. */
  noteRename(from: string, to: string): void {
    this.renames[to] = from;
    const keys = Object.keys(this.renames);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RENAMES))) delete this.renames[k];
    this.changed();
  }

  /**
   * The recorder of run `key`, started if new. A run that never creates anything is not kept; only the last
   * MAX_RUNS runs are.
   */
  begin(key: string, label: string, root: string): Recorder {
    let run = this.runs.find((r) => r.key === key);
    const fresh = run === undefined;
    if (!run) {
      run = { key, at: this.now(), label, root, folders: [], files: [] };
      const from = this.renames[root];
      if (from !== undefined) { run.rename = { from, to: root }; delete this.renames[root]; }
    }
    const rec = run;
    const keep = () => {
      if (!this.runs.includes(rec)) {
        this.runs.push(rec);
        if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
      }
      this.changed();
    };
    void fresh;
    return {
      folder: (path) => { if (!rec.folders.includes(path)) rec.folders.push(path); keep(); },
      file: (path) => { if (!rec.files.some((f) => f.path === path)) rec.files.push({ path, at: this.now() }); keep(); },
      root: (path) => { rec.root = path; if (this.runs.includes(rec)) this.changed(); },
    };
  }

  remove(key: string): void {
    const n = this.runs.length;
    this.runs = this.runs.filter((r) => r.key !== key);
    if (this.runs.length !== n) this.changed();
  }

  /** The vault renamed `from` to `to`: every logged path follows. */
  renamePath(from: string, to: string): void {
    let hit = false;
    const mv = (p: string) => { const q = move(p, from, to); if (q !== p) hit = true; return q; };
    for (const r of this.runs) {
      r.root = mv(r.root);
      r.folders = r.folders.map(mv);
      r.files = r.files.map((f) => ({ ...f, path: mv(f.path) }));
      if (r.rename) r.rename = { from: mv(r.rename.from), to: mv(r.rename.to) };
    }
    if (hit) this.changed();
  }

  private changed(): void { this.onChange(this.list(), this.renamesMap()); }
}

/** What the vault looks like right now. */
export interface UndoView {
  /** Modified time of a file; null when it does not exist. */
  mtime(path: string): number | null;
  /** Names inside a folder; null when it does not exist. */
  children(folder: string): string[] | null;
}

export interface UndoPlan {
  /** Files first, then folders deepest first. */
  trash: { path: string; kind: "file" | "folder" }[];
  kept: { path: string; reason: "edited" | "not empty" }[];
  counts: { folders: number; notes: number };
  renameBack?: { path: string; newPath: string };
}

export function planUndo(run: RunRecord, view: UndoView): UndoPlan {
  const trash: UndoPlan["trash"] = [];
  const kept: UndoPlan["kept"] = [];
  const gone = new Set<string>();
  for (const f of run.files) {
    const m = view.mtime(f.path);
    if (m === null) continue;
    if (m > f.at + EDIT_SLACK_MS) { kept.push({ path: f.path, reason: "edited" }); continue; }
    trash.push({ path: f.path, kind: "file" });
    gone.add(f.path);
  }
  const folders = [...new Set(run.folders)].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const folder of folders) {
    const names = view.children(folder);
    if (names === null) continue;
    if (names.every((n) => gone.has(`${folder}/${n}`))) {
      trash.push({ path: folder, kind: "folder" });
      gone.add(folder);
    } else {
      kept.push({ path: folder, reason: "not empty" });
    }
  }
  const plan: UndoPlan = {
    trash,
    kept,
    counts: { folders: trash.filter((t) => t.kind === "folder").length, notes: trash.filter((t) => t.kind === "file").length },
  };
  // The folder goes back to its trigger name only when nothing is left in it and the old name is free.
  const rn = run.rename;
  if (rn) {
    const left = view.children(rn.to);
    if (left !== null && left.every((n) => gone.has(`${rn.to}/${n}`)) && view.children(rn.from) === null && view.mtime(rn.from) === null) {
      plan.renameBack = { path: rn.to, newPath: rn.from };
    }
  }
  return plan;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function confirmText(plan: UndoPlan, run: RunRecord): string {
  const d = new Date(run.at);
  let text = `Delete ${plural(plan.counts.folders, "folder")} and ${plural(plan.counts.notes, "note")} created on ${d.getDate()} ${MONTHS[d.getMonth()]}?`;
  text += " They go to the system trash, so you can restore them.";
  if (plan.kept.length > 0) text += ` Will keep ${plan.kept.length} item${plan.kept.length === 1 ? "" : "s"} you edited or added to.`;
  if (plan.renameBack) text += " The folder gets its old name back.";
  return text;
}

export interface UndoOps {
  trash(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** Runs the plan. A failure is listed and the rest continues; the rename back is skipped if anything failed. */
export async function executeUndo(plan: UndoPlan, ops: UndoOps): Promise<{ trashed: number; failed: string[] }> {
  let trashed = 0;
  const failed: string[] = [];
  for (const t of plan.trash) {
    try { await ops.trash(t.path); trashed++; } catch { failed.push(t.path); }
  }
  if (plan.renameBack && failed.length === 0) {
    try { await ops.rename(plan.renameBack.path, plan.renameBack.newPath); } catch { failed.push(plan.renameBack.path); }
  }
  return { trashed, failed };
}
