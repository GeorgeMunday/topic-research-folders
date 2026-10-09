// Pure: the state of each researched folder or PDF in the file explorer, and the icon that shows it.
// No `obsidian` import; the UI layer renders `iconFor(mark)`.

export type MarkState = "working" | "ready" | "done" | "failed";
export interface Mark { path: string; state: MarkState; error?: string }

export type IconName = "spinner" | "sparkles" | "check" | "alert-triangle";
export interface IconSpec {
  icon: IconName;
  tooltip: string;
  /** What a click does; null = not clickable. */
  action: "review" | "retry" | null;
  /** One-time fade-in (ready) or fade-out (done); never repeating. */
  fade?: "in" | "out";
}

export const DONE_MS = 3000;

export function iconFor(m: Mark): IconSpec {
  switch (m.state) {
    case "working": return { icon: "spinner", tooltip: "Researching…", action: null };
    case "ready": return { icon: "sparkles", tooltip: "Suggestions ready — click to review", action: "review", fade: "in" };
    case "done": return { icon: "check", tooltip: "Research finished", action: null, fade: "out" };
    case "failed": return { icon: "alert-triangle", tooltip: m.error ? `${m.error} — click to retry` : "Research failed — click to retry", action: "retry" };
  }
}

/**
 * Allowed moves: anything → working; working → ready | done | failed. A restored review starts at ready and a
 * run rejected before it started at failed. Cancelled has no state: the mark is removed.
 */
export function canMove(from: MarkState | undefined, to: MarkState): boolean {
  if (to === "working") return true;
  if (from === undefined) return to === "ready" || to === "failed";
  if (from === to) return true;
  return from === "working" && (to === "ready" || to === "done" || to === "failed");
}

export class MarkBoard {
  private byPath = new Map<string, Mark>();
  private timers = new Map<string, () => void>();

  /** `later` schedules fn after ms and returns a function that cancels it. */
  constructor(private later: (fn: () => void, ms: number) => () => void, private onChange: () => void = () => {}) {}

  /** False when the move is not allowed (the mark is left as it was). */
  set(path: string, state: MarkState, error?: string): boolean {
    const cur = this.byPath.get(path);
    if (!canMove(cur?.state, state)) return false;
    this.stopTimer(path);
    const next: Mark = error !== undefined && state === "failed" ? { path, state, error } : { path, state };
    const same = cur && cur.state === next.state && cur.error === next.error;
    this.byPath.set(path, next);
    if (state === "done") {
      this.timers.set(path, this.later(() => { this.timers.delete(path); this.remove(path); }, DONE_MS));
    }
    if (!same || state === "done") this.onChange();
    return true;
  }

  /** Cancelled (or gone): nothing is left to show. */
  remove(path: string): void {
    this.stopTimer(path);
    if (this.byPath.delete(path)) this.onChange();
  }

  get(path: string): Mark | undefined { return this.byPath.get(path); }
  marks(): Mark[] { return [...this.byPath.values()]; }
  dispose(): void { for (const p of [...this.timers.keys()]) this.stopTimer(p); }

  private stopTimer(path: string): void {
    const t = this.timers.get(path);
    if (t) { t(); this.timers.delete(path); }
  }
}

/** Status bar text when ready reviews could not be shown in the explorer; "" when there is nothing to say. */
export function fallbackStatus(unplacedReady: number): string {
  return unplacedReady > 0 ? `✦ ${unplacedReady} ready to review` : "";
}
