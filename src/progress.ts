import type { Progress } from "./types";

export interface ProgressSource { kind: "research" | "pdf"; resumed: boolean; }
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
