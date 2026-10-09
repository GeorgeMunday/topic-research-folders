import type { Progress } from "./types";

export interface ProgressSource { kind: "research" | "pdf"; resumed: boolean; runId?: number; }
export type ProgressSink = (path: string, e: Progress, src: ProgressSource) => void;
export const CANCELLED_MESSAGE = "Cancelled";
export const OUTLINE_STAGE_MS = 8000;

export class ProgressTracker {
  // Map insertion order = activation order; texts keyed by path.
  private texts = new Map<string, string>();
  private lastUpdated: string | null = null;
  private listeners = new Set<() => void>();

  handle(path: string, e: Progress, _src: ProgressSource): void {
    if (e.kind === "done" || e.kind === "failed") {
      if (!this.texts.delete(path)) return;
      if (this.lastUpdated === path) this.lastUpdated = this.latestRemaining();
      this.emit();
      return;
    }
    const prevText = this.texts.get(path);
    const wasActive = prevText !== undefined;
    let text = prevText ?? "";
    if (e.kind === "step") text = e.text;
    else if (e.kind === "writing") text = `Writing folder ${e.index} of ${e.total}: ${e.name}`;
    else if (e.kind === "outline") text = "Choosing folders…";
    const oldSuffix = this.statusSuffix();
    this.texts.set(path, text);
    this.lastUpdated = path;
    if (!wasActive || this.statusSuffix() !== oldSuffix) this.emit();
  }

  active(): string[] { return [...this.texts.keys()]; }

  statusSuffix(): string {
    return this.lastUpdated !== null ? (this.texts.get(this.lastUpdated) ?? "") : "";
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  clear(path?: string): void {
    if (path === undefined) {
      if (this.texts.size === 0) return;
      this.texts.clear();
      this.lastUpdated = null;
    } else {
      if (!this.texts.delete(path)) return;
      if (this.lastUpdated === path) this.lastUpdated = this.latestRemaining();
    }
    this.emit();
  }

  private latestRemaining(): string | null {
    let last: string | null = null;
    for (const k of this.texts.keys()) last = k;
    return last;
  }

  private emit(): void {
    for (const fn of [...this.listeners]) { try { fn(); } catch { /* ignore */ } }
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function noticeFor(
  _path: string,
  e: Progress,
  src: ProgressSource,
  ctx: { modalOpen: boolean; topic: string },
): { text: string; error: boolean } | null {
  if (src.kind !== "research" || ctx.modalOpen) return null;
  if (e.kind === "done") return { text: `Researched ${ctx.topic}: ${plural(e.folders, "folder")}, ${plural(e.notes, "note")}`, error: false };
  if (e.kind === "failed") {
    if (e.error === CANCELLED_MESSAGE) return null;
    return { text: `Research failed for ${ctx.topic}: ${e.error}`, error: true };
  }
  if (e.kind === "itemDone" && !e.ok) return { text: `Could not research "${e.name}": ${e.error ?? "unknown error"}`, error: true };
  return null;
}

// Decides whether a progress event belongs to the run the UI currently tracks for a path.
export class RunGate {
  private current = new Map<string, number>();
  private ended = new Set<string>();
  private cancelled = new Set<number>();

  accept(path: string, e: Progress, src: ProgressSource): boolean {
    const id = src.runId;
    if (id === undefined) return true;
    if (this.cancelled.has(id)) return false;
    const cur = this.current.get(path);
    if (cur !== id) {
      if (cur !== undefined && id < cur) return false;
      if (!(cur === undefined || this.ended.has(path) || e.kind === "step")) return false;
      this.current.set(path, id);
      this.ended.delete(path);
    }
    if (e.kind === "done" || e.kind === "failed") this.ended.add(path);
    return true;
  }

  currentRun(path: string): number | undefined { return this.current.get(path); }

  cancel(path: string): void {
    const cur = this.current.get(path);
    if (cur !== undefined) this.cancelled.add(cur);
    this.current.delete(path);
    this.ended.delete(path);
  }
}
