import { navSelector } from "./explorerSpinner";
import { iconFor, type IconName, type Mark } from "./marks";

export interface MarksDeps {
  /** Draws the icon (Lucide) into the element. */
  render(el: HTMLElement, icon: IconName): void;
  /** The user clicked a clickable icon. */
  onActivate(path: string): void;
  /** Ready reviews whose explorer row could not be found (the status bar takes over); called when that set changes. */
  onUnplaced(readyPaths: string[]): void;
}

const CONTENT = ".nav-folder-title-content, .nav-file-title-content";

/** One small icon inside the name of each marked folder or PDF in the file explorer. */
export class ExplorerMarks {
  private marks: Mark[] = [];
  private observers: MutationObserver[] = [];
  private raf: number | null = null;
  private unplaced = "";

  constructor(private doc: Document, private deps: MarksDeps) {}

  set(marks: Mark[]): void {
    this.marks = marks;
    this.apply();
  }

  reattach(): void {
    this.disconnect();
    for (const el of Array.from(this.doc.querySelectorAll('[data-type="file-explorer"]'))) {
      const mo = new MutationObserver(() => this.schedule());
      mo.observe(el, { childList: true, subtree: true });
      this.observers.push(mo);
    }
    this.apply();
  }

  stop(): void {
    this.disconnect();
    this.marks = [];
    for (const el of Array.from(this.doc.querySelectorAll(".trf-mark"))) el.remove();
  }

  private disconnect(): void {
    for (const mo of this.observers) mo.disconnect();
    this.observers = [];
    if (this.raf !== null) { window.cancelAnimationFrame(this.raf); this.raf = null; }
  }

  private schedule(): void {
    if (this.raf !== null) return;
    this.raf = window.requestAnimationFrame(() => { this.raf = null; this.apply(); });
  }

  private apply(): void {
    const keep = new Set<Element>();
    const unplaced: string[] = [];
    for (const m of this.marks) {
      let placed = false;
      for (const title of Array.from(this.doc.querySelectorAll(navSelector(m.path)))) {
        const host = title.querySelector(CONTENT);
        if (!host) continue;
        placed = true;
        keep.add(this.place(host as HTMLElement, m));
      }
      if (!placed && m.state === "ready") unplaced.push(m.path);
    }
    // Observers run through here too: removing our own stale icons is a mutation, but it settles after one pass.
    for (const el of Array.from(this.doc.querySelectorAll(".trf-mark"))) if (!keep.has(el)) el.remove();
    const sig = unplaced.join("\n");
    if (sig !== this.unplaced) { this.unplaced = sig; this.deps.onUnplaced(unplaced); }
  }

  private place(host: HTMLElement, m: Mark): Element {
    const spec = iconFor(m);
    const key = `${m.state}|${m.error ?? ""}`;
    const existing = host.querySelector(":scope > .trf-mark");
    if (existing && existing.getAttribute("data-key") === key) return existing;
    existing?.remove();
    const el = this.doc.createElement("span");
    el.className = `trf-mark trf-mark-${m.state}${spec.action ? " trf-mark-clickable" : ""}`;
    el.setAttribute("data-key", key);
    el.setAttribute("aria-label", spec.tooltip);
    el.setAttribute("title", spec.tooltip);
    this.deps.render(el, spec.icon);
    // The icon sits inside the row: a click on it must not also open or collapse the folder.
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      if (spec.action) this.deps.onActivate(m.path);
    });
    host.appendChild(el);
    return el;
  }
}
