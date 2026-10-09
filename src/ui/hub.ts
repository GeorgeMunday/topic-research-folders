// Pure progress hub: turns flow/queue events into notices, status text and spinners. No `obsidian` import.
import type { Job, Outline, SubfolderSuggestion } from "../types";
import { ProgressTracker, RunGate, nextRunId, noticeFor } from "../progress";
import type { ProgressSink, ProgressSource } from "../progress";

export interface PendingReview { path: string; outline: Outline; }

export interface HubUi {
  notice(text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }): void;
  setStatus(text: string): void;                 // "" hides the item
  setSpinners(paths: string[]): void;
  reviewModal(outline: Outline): Promise<SubfolderSuggestion[] | null>;   // resolves null when closed without Create
}

export interface HubActions {
  startApproved(path: string, approved: SubfolderSuggestion[]): void;      // enqueue the research job with `approved`
  cancelJob(kind: Job["kind"], path: string): boolean;
  retry(path: string): void;
  persistPending(list: PendingReview[]): void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export class ProgressHub {
  private tracker = new ProgressTracker();
  private gate = new RunGate();
  private pendingList: PendingReview[] = [];
  private reviewing = new Set<string>();
  private noticed = new Set<string>();
  // Last run per path that ended with a failed event (lets a queue failure reuse that run id).
  private lastFailed = new Map<string, { kind: ProgressSource["kind"]; runId: number }>();
  // Run id of the outline run behind each pending review.
  private pendingRun = new Map<string, number>();
  private counts = { running: 0, queued: 0 };
  private shownStatus = "";
  private shownSpinners: string[] = [];
  private disposed = false;

  constructor(private ui: HubUi, private actions: HubActions) {}

  readonly sink: ProgressSink = (path, e, src) => {
    if (this.disposed) return;
    // A repeat outline of the run that produced the pending review replaces it (that run is already ended in the gate).
    if (src.kind === "research" && e.kind === "outline" && src.runId !== undefined && this.pendingRun.get(path) === src.runId) {
      this.recordOutline(path, e.outline, src);
      this.refresh();
      return;
    }
    if (!this.gate.accept(path, e, src)) return;
    this.tracker.handle(path, e, src);
    if (e.kind === "failed" && src.runId !== undefined) this.lastFailed.set(path, { kind: src.kind, runId: src.runId });
    else if (e.kind === "step" || e.kind === "done") this.lastFailed.delete(path);
    if (src.kind === "research" && e.kind === "outline") this.recordOutline(path, e.outline, src);
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
    const cur = this.gate.currentRun(job.path);
    const prev = this.lastFailed.get(job.path);
    let runId: number;
    if (this.gate.live(job.path) && cur !== undefined) runId = cur;
    // The flow already reported a failure for its (now ended) run: reuse that id so no second notice appears.
    else if (prev && prev.kind === job.kind && prev.runId === cur) runId = prev.runId;
    else runId = nextRunId();
    this.sink(job.path, { kind: "failed", error: message }, { kind: job.kind, resumed: job.kind === "research" && !!job.approved, runId });
    // One-shot: the queue gave up on this job, so a later failure on the path belongs to a new job.
    this.lastFailed.delete(job.path);
  }

  restorePending(list: PendingReview[], jobs: Job[]): void {
    if (this.disposed) return;
    this.pendingList = list.map((p) => ({ ...p }));
    this.pendingRun.clear();
    for (const p of this.pendingList) this.showReady(p.path);
    for (const job of jobs) {
      this.tracker.handle(job.path, { kind: "step", text: `Resuming ${baseName(job.path)}…` }, { kind: job.kind, resumed: true });
    }
    this.refresh();
  }

  pending(): PendingReview[] { return this.pendingList.map((p) => ({ ...p })); }

  review(path?: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const entry = path !== undefined
      ? this.pendingList.find((p) => p.path === path)
      : this.pendingList.find((p) => !this.reviewing.has(p.path)) ?? this.pendingList[0];
    if (!entry) {
      this.ui.notice("No suggestions are waiting for review.");
      return Promise.resolve();
    }
    if (this.reviewing.has(entry.path)) return Promise.resolve();
    const target = entry.path;
    this.reviewing.add(target);
    let result: Promise<SubfolderSuggestion[] | null>;
    try { result = this.ui.reviewModal(entry.outline); } catch (e) { result = Promise.reject(e); }
    return result.then(
      (approved) => {
        this.reviewing.delete(target);
        // Ignore a result for a review that was cancelled or replaced meanwhile.
        if (this.disposed || !this.pendingList.includes(entry)) return;
        this.pendingList = this.pendingList.filter((p) => p !== entry);
        this.actions.persistPending(this.pending());
        this.pendingRun.delete(target);
        if (approved && approved.length > 0) {
          this.gate.cancel(target);
          this.tracker.handle(target, { kind: "step", text: `Researching ${baseName(target)}…` }, { kind: "research", resumed: false });
          this.actions.startApproved(target, approved);
        } else {
          this.tracker.clear(target);
          this.gate.cancel(target);
          this.ui.notice("Cancelled");
        }
        this.refresh();
      },
      () => { this.reviewing.delete(target); },
    );
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

  menuItems(): { label: string; run: () => void }[] {
    if (this.disposed) return [];
    const items: { label: string; run: () => void }[] = [];
    const busy = this.counts.running + this.counts.queued > 0 || this.tracker.active().length > 0;
    if (busy || this.pendingList.length > 0) items.push({ label: "Cancel all research jobs", run: () => this.cancelAll() });
    if (this.pendingList.length > 0) items.push({ label: "Review pending suggestions", run: () => { void this.review(); } });
    return items;
  }

  dispose(): void { this.disposed = true; }

  private recordOutline(path: string, outline: Outline, src: ProgressSource): void {
    const existing = this.pendingList.findIndex((p) => p.path === path);
    const entry: PendingReview = { path, outline };
    if (existing >= 0) this.pendingList[existing] = entry; else this.pendingList.push(entry);
    this.actions.persistPending(this.pending());
    // One "ready" notice per run (per path when the event carries no run id).
    const notify = src.runId !== undefined ? !this.noticed.has(`${src.runId}|outline`) : existing < 0;
    if (src.runId !== undefined) this.noticed.add(`${src.runId}|outline`);
    if (notify) this.showReady(path);
    // The outline run is over once a review is pending: ignore its trailing events and let the pending set
    // keep the spinner, so the approved run (new id) is accepted even when its first event is a failed.
    if (src.runId !== undefined) this.pendingRun.set(path, src.runId); else this.pendingRun.delete(path);
    this.gate.cancel(path);
    this.tracker.clear(path);
  }

  private showReady(path: string): void {
    this.ui.notice(`Suggestions ready for ${baseName(path)}`, { action: { label: "Review", run: () => { void this.review(path); } } });
  }

  private refresh(): void {
    const active = this.tracker.active();
    const spinners = [...new Set([...active, ...this.pendingList.map((p) => p.path)])];
    let status = "";
    if (active.length > 0) {
      status = this.tracker.statusSuffix();
      if (active.length > 1) status += ` (+${active.length - 1} more)`;
    } else if (this.pendingList.length > 0) {
      status = `Suggestions ready (${this.pendingList.length})`;
    }
    if (spinners.length !== this.shownSpinners.length || spinners.some((p, i) => p !== this.shownSpinners[i])) {
      this.shownSpinners = spinners;
      this.ui.setSpinners([...spinners]);
    }
    if (status !== this.shownStatus) {
      this.shownStatus = status;
      this.ui.setStatus(status);
    }
  }
}

