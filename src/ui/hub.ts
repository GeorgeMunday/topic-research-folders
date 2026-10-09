// Pure progress hub: turns flow/queue events into notices, status text and spinners. No `obsidian` import.
import type { Job, Outline, PendingReview, Progress, SubfolderSuggestion } from "../types";
import { ProgressTracker, RunGate, isNeutralMessage, nextRunId, noticeFor } from "../progress";
import { MarkBoard, type Mark } from "./marks";
import type { ProgressSink, ProgressSource } from "../progress";

export type { PendingReview };

export interface HubUi {
  notice(text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }): void;
  setStatus(text: string): void;                 // "" hides the item
  /** Folders or PDFs being worked on (the spinner). */
  setSpinners(paths: string[]): void;
  /** Everything else worth an icon: ready to review, done (fades), failed. */
  setMarks?(marks: Mark[]): void;
  reviewModal(outline: Outline, hooks?: ReviewHooks): Promise<SubfolderSuggestion[] | null>;   // resolves null when closed without Create
}

/** What the review window needs besides the outline: the folder, and a way to ask for new suggestions. */
export interface ReviewHooks {
  path: string;
  /** Prefix the created folders with 01 - , 02 - … in the order shown. */
  numberFolders?: boolean;
  /** New suggestions for an edited topic; the hub keeps the result as the entry's outline (used by Create). */
  resuggest?(topic: string): Promise<Outline>;
}

export interface HubActions {
  /** Enqueue the research job with `approved` (the outline is passed for its summary); false when the queue refused it. */
  startApproved(path: string, approved: SubfolderSuggestion[], outline: Outline): boolean;
  /** Asks for a new outline of `path` under an edited topic (the review's Re-suggest button). */
  resuggest?(path: string, topic: string): Promise<Outline>;
  /** Starts the run again for a failed path (`kind` is what failed: research or pdf). */
  retry?(path: string, kind: ProgressSource["kind"]): void;
  /** The "Number folders in learning order" setting. */
  numberFolders?(): boolean;
  /** False when the folder no longer exists in the vault. */
  pathExists(path: string): boolean;
  persistPending(list: PendingReview[]): void;
  /** Stops the queued and running jobs (queue side of "Cancel all"); the hub then clears its own state. */
  cancelAllJobs?(): void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.lastIndexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "");

export class ProgressHub {
  private tracker = new ProgressTracker();
  private gate = new RunGate();
  private pendingList: PendingReview[] = [];
  // Entries whose review modal is open (entries are renamed in place, so this follows renames).
  private reviewing = new Set<PendingReview>();
  // Accepted events per path; tells whether a run reported something while it was being started.
  private seq = new Map<string, number>();
  private noticed = new Set<string>();
  // Last run per path that ended with a failed event (lets a queue failure reuse that run id).
  private lastFailed = new Map<string, { kind: ProgressSource["kind"]; runId: number }>();
  // Run id of the outline run behind each pending review.
  private pendingRun = new Map<string, number>();
  private counts = { running: 0, queued: 0 };
  private shownStatus = "";
  private shownSpinners: string[] = [];
  // Where a tracked path's spinner is shown: a key point's events are keyed by its entry note, the spinner
  // goes on its folder (shared by every key point in it, so it stays until all of them have ended).
  private display = new Map<string, string>();
  private disposed = false;
  private board: MarkBoard;
  private failedKind = new Map<string, ProgressSource["kind"]>();
  private shownMarks = "";
  private syncing = false;

  constructor(private ui: HubUi, private actions: HubActions, later: (fn: () => void, ms: number) => () => void = (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }) {
    this.board = new MarkBoard(later, () => { if (!this.disposed && !this.syncing) this.refresh(); });
  }

  readonly sink: ProgressSink = (path, e, src) => {
    if (this.disposed) return;
    // A repeat outline of the run that produced the pending review replaces it (that run is already ended in the gate).
    if (src.kind === "research" && e.kind === "outline" && src.runId !== undefined && this.pendingRun.get(path) === src.runId) {
      this.recordOutline(path, e.outline, src);
      this.refresh();
      return;
    }
    if (!this.gate.accept(path, e, src)) return;
    if (src.kind === "keypoint") this.display.set(path, parentOf(path));
    this.seq.set(path, (this.seq.get(path) ?? 0) + 1);
    this.tracker.handle(path, e, src);
    if (e.kind === "failed" && src.runId !== undefined) this.lastFailed.set(path, { kind: src.kind, runId: src.runId });
    else if (e.kind === "step" || e.kind === "done") this.lastFailed.delete(path);
    if (src.kind === "research" && e.kind === "outline") this.recordOutline(path, e.outline, src);
    this.markEnd(path, e, src);
    const note = noticeFor(path, e, src, { topic: baseName(path) });
    if (note) {
      const run = src.runId ?? path;
      const key = e.kind === "itemDone" ? `${run}|item|${e.name}` : `${run}|end`;
      if (!this.noticed.has(key)) {
        this.noticed.add(key);
        this.ui.notice(note.text, note.error ? { error: true } : undefined);
      }
    }
    this.refresh();
  };

  onQueueChange(running: number, queued: number): void {
    if (this.disposed) return;
    this.counts = { running, queued };
    if (running + queued === 0) this.tracker.clear();
    this.refresh();
  }

  onQueueFailed(job: Job, err: unknown): void {
    if (this.disposed) return;
    const message = err instanceof Error ? err.message : "unexpected error";
    const path = job.path;
    const cur = this.gate.currentRun(path);
    const prev = this.lastFailed.get(path);
    let runId: number;
    if (this.gate.live(path) && cur !== undefined) runId = cur;
    // The flow already reported a failure for its (now ended) run: reuse that id so no second notice appears.
    else if (prev && prev.kind === job.kind && prev.runId === cur) runId = prev.runId;
    else runId = nextRunId();
    this.sink(path, { kind: "failed", error: message }, { kind: job.kind, resumed: job.kind === "research" && !!job.approved, runId });
    // One-shot: the queue gave up on this job, so a later failure on the path belongs to a new job.
    this.lastFailed.delete(path);
  }

  restorePending(list: PendingReview[], jobs: Job[]): void {
    if (this.disposed) return;
    this.pendingList = list.map((p) => ({ ...p }));
    this.pendingRun.clear();
    for (const job of jobs) {
      const path = job.path;
      if (job.kind === "keypoint") this.display.set(path, parentOf(path));
      const name = job.kind === "keypoint" ? job.point.name : baseName(path);
      this.tracker.handle(path, { kind: "step", text: `Resuming ${name}…` }, { kind: job.kind, resumed: true });
    }
    this.refresh();
  }

  pending(): PendingReview[] { return this.pendingList.map((p) => ({ ...p })); }

  /** Opens the review for `path` (or the oldest one not being reviewed). Never rejects. */
  review(path?: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const problem = (e: unknown) => {
      if (this.disposed) return;
      try { this.ui.notice(`Review problem: ${e instanceof Error ? e.message : "unexpected error"}`, { error: true }); } catch { /* ignore */ }
    };
    let entry: PendingReview | undefined;
    let result: Promise<SubfolderSuggestion[] | null>;
    try {
      const busy = (p: string) => [...this.reviewing].some((e) => e.path === p);
      entry = path !== undefined
        ? this.pendingList.find((p) => p.path === path)
        : this.pendingList.find((p) => !busy(p.path)) ?? this.pendingList[0];
      if (!entry) {
        this.ui.notice("No suggestions are waiting for review.");
        return Promise.resolve();
      }
      if (busy(entry.path)) return Promise.resolve();
      if (!this.actions.pathExists(entry.path)) { this.forgetMissing(entry); return Promise.resolve(); }
      this.reviewing.add(entry);
      const open = entry;
      const resuggest = this.actions.resuggest;
      result = this.ui.reviewModal(entry.outline, {
        path: entry.path,
        ...(this.actions.numberFolders ? { numberFolders: this.actions.numberFolders() } : {}),
        ...(resuggest ? {
          resuggest: async (topic: string) => {
            const outline = await resuggest.call(this.actions, open.path, topic);
            // The entry may have been cancelled or dropped while the request ran.
            if (!this.disposed && this.pendingList.includes(open)) {
              open.outline = outline;
              this.actions.persistPending(this.pending());
            }
            return outline;
          },
        } : {}),
      });
    } catch (e) {
      if (entry) this.reviewing.delete(entry);
      problem(e);
      return Promise.resolve();
    }
    const reviewed = entry;
    return Promise.resolve(result)
      .then((approved) => { this.reviewing.delete(reviewed); this.settleReview(reviewed, approved); })
      .catch((e) => { this.reviewing.delete(reviewed); problem(e); });
  }

  /** A pending folder was renamed: its review (and any below it) follows the new path. */
  renamePending(oldPath: string, newPath: string): void {
    if (this.disposed) return;
    let changed = false;
    for (const e of this.pendingList) {
      const moved = e.path === oldPath ? newPath : e.path.startsWith(`${oldPath}/`) ? newPath + e.path.slice(oldPath.length) : null;
      if (moved === null) continue;
      const run = this.pendingRun.get(e.path);
      this.pendingRun.delete(e.path);
      if (run !== undefined) this.pendingRun.set(moved, run);
      e.path = moved; // in place, so an open review still recognises its entry
      changed = true;
    }
    if (!changed) return;
    this.actions.persistPending(this.pending());
    this.refresh();
  }

  /** A pending folder was deleted: drop its review (and any below it) quietly. */
  dropPending(path: string): void {
    if (this.disposed) return;
    const gone = this.pendingList.filter((e) => e.path === path || e.path.startsWith(`${path}/`));
    if (gone.length === 0) return;
    for (const e of gone) this.removeEntry(e, false);
    this.actions.persistPending(this.pending());
    this.refresh();
  }

  cancelAll(): void {
    if (this.disposed) return;
    for (const p of new Set([...this.tracker.active(), ...this.pendingList.map((x) => x.path)])) this.gate.cancel(p);
    this.pendingList = [];
    this.pendingRun.clear();
    this.actions.persistPending([]);
    this.tracker.clear();
    this.refresh();
    this.ui.notice("Cancelled all research jobs.");
  }

  /** The user's "Cancel all": stop the jobs (injected queue side), then clear pending reviews, spinners and status. */
  cancelEverything(): void {
    if (this.disposed) return;
    try { this.actions.cancelAllJobs?.(); } finally { this.cancelAll(); }
  }

  menuItems():{ label: string; run: () => void }[] {
    if (this.disposed) return [];
    const items: { label: string; run: () => void }[] = [];
    const busy = this.counts.running + this.counts.queued > 0 || this.tracker.active().length > 0;
    if (busy || this.pendingList.length > 0) items.push({ label: "Cancel all research jobs", run: () => this.cancelEverything() });
    if (this.pendingList.length > 0) items.push({ label: "Review pending suggestions", run: () => { void this.review(); } });
    return items;
  }

  /** What clicking a path's icon does: open its review, or retry a failed run. */
  activate(path: string): void {
    if (this.disposed) return;
    const m = this.board.get(path);
    if (m?.state === "ready") void this.review(path);
    else if (m?.state === "failed") this.retry(path);
  }

  /** Right-click menu entries for a folder or PDF, by its mark. */
  menuFor(path: string): { label: string; run: () => void }[] {
    if (this.disposed) return [];
    const state = this.board.get(path)?.state;
    if (state === "ready") return [{ label: "Review suggestions", run: () => { void this.review(path); } }];
    if (state === "failed" && this.actions.retry) return [{ label: "Retry research", run: () => this.retry(path) }];
    return [];
  }

  dispose(): void { this.disposed = true; this.board.dispose(); }

  private retry(path: string): void {
    const kind = this.failedKind.get(path);
    if (kind) this.actions.retry?.(path, kind);
  }

  // Terminal events of a folder or PDF run set the done / failed mark; a cancel leaves no mark.
  private markEnd(path: string, e: Progress, src: ProgressSource): void {
    if (src.kind === "keypoint") return;
    if (e.kind === "done") this.board.set(path, "done");
    else if (e.kind === "failed") {
      if (isNeutralMessage(e.error)) this.board.remove(path);
      else { this.failedKind.set(path, src.kind); this.board.set(path, "failed", e.error); }
    }
  }

  private settleReview(entry: PendingReview, approved: SubfolderSuggestion[] | null): void {
    // Ignore a result for a review that was cancelled, dropped or replaced meanwhile.
    if (this.disposed || !this.pendingList.includes(entry)) return;
    const target = entry.path;
    if (!approved || approved.length === 0) {
      // The outline run already ended when it was recorded (or was restored from data.json), so any run
      // the gate or tracker holds for this path now is a newer one (e.g. a re-run): leave it alone.
      this.removeEntry(entry, true);
      this.ui.notice("Cancelled");
      this.refresh();
      return;
    }
    if (!this.actions.pathExists(target)) { this.forgetMissing(entry); return; }
    // Start first: when a newer run of the folder is queued or running the queue refuses the job, and then
    // nothing may change (the choice stays pending, the newer run keeps its events and its outline).
    const seenBefore = this.seq.get(target) ?? 0;
    if (!this.actions.startApproved(target, approved, entry.outline)) {
      this.ui.notice(`${baseName(target)} is already being researched — review again when it finishes.`);
      return;
    }
    this.removeEntry(entry, true);
    // Show progress right away unless the new run already reported (e.g. it failed synchronously).
    if ((this.seq.get(target) ?? 0) === seenBefore) {
      this.tracker.handle(target, { kind: "step", text: `Researching ${baseName(target)}…` }, { kind: "research", resumed: false });
    }
    this.refresh();
  }

  private removeEntry(entry: PendingReview, persist: boolean): void {
    this.pendingList = this.pendingList.filter((p) => p !== entry);
    this.pendingRun.delete(entry.path);
    if (persist) this.actions.persistPending(this.pending());
  }

  private forgetMissing(entry: PendingReview): void {
    this.removeEntry(entry, true);
    this.ui.notice(`${baseName(entry.path)} no longer exists, nothing was started.`);
    this.refresh();
  }

  private recordOutline(path: string, outline: Outline, src: ProgressSource): void {
    const existing = this.pendingList.findIndex((p) => p.path === path);
    const entry: PendingReview = { path, outline };
    if (existing >= 0) this.pendingList[existing] = entry; else this.pendingList.push(entry);
    this.actions.persistPending(this.pending());
    // The outline run is over once a review is pending: ignore its trailing events and let the pending set
    // keep the spinner, so the approved run (new id) is accepted even when its first event is a failed.
    if (src.runId !== undefined) this.pendingRun.set(path, src.runId); else this.pendingRun.delete(path);
    this.gate.cancel(path);
    this.tracker.clear(path);
  }

  // Working and ready marks mirror the tracker and the pending reviews; done and failed stay until they expire or a new run starts.
  private syncBoard(working: Set<string>, ready: string[]): void {
    this.syncing = true;
    try {
      for (const p of working) this.board.set(p, "working");
      for (const p of ready) if (!working.has(p)) this.board.set(p, "ready");
      for (const m of this.board.marks()) {
        if (m.state === "working" && !working.has(m.path)) this.board.remove(m.path);
        else if (m.state === "ready" && !working.has(m.path) && !ready.includes(m.path)) this.board.remove(m.path);
      }
    } finally { this.syncing = false; }
  }

  private refresh(): void {
    const active = this.tracker.active();
    for (const p of [...this.display.keys()]) if (!active.includes(p)) this.display.delete(p);
    const spinners = [...new Set(active.map((p) => this.display.get(p) ?? p))];
    this.syncBoard(new Set(spinners), this.pendingList.map((p) => p.path));
    let status = "";
    if (active.length > 0) {
      status = this.tracker.statusSuffix();
      if (active.length > 1) status += ` (+${active.length - 1} more)`;
    }
    if (spinners.length !== this.shownSpinners.length || spinners.some((p, i) => p !== this.shownSpinners[i])) {
      this.shownSpinners = spinners;
      this.ui.setSpinners([...spinners]);
    }
    const marks = this.board.marks().filter((m) => m.state !== "working");
    const sig = JSON.stringify(marks);
    if (sig !== this.shownMarks) {
      this.shownMarks = sig;
      this.ui.setMarks?.(marks.map((m) => ({ ...m })));
    }
    if (status !== this.shownStatus) {
      this.shownStatus = status;
      this.ui.setStatus(status);
    }
  }
}

