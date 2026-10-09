const CLS = "trf-working";

export function navSelector(path: string): string {
  const p = path.split("\\").join("\\\\").split('"').join('\\"');
  return `.nav-folder-title[data-path="${p}"], .nav-file-title[data-path="${p}"]`;
}

export class ExplorerSpinner {
  private paths = new Set<string>();
  private observers: MutationObserver[] = [];
  private raf: number | null = null;

  constructor(private doc: Document) {}

  set(paths: string[]): void {
    this.paths = new Set(paths);
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
    this.paths = new Set();
    for (const el of Array.from(this.doc.querySelectorAll(`.${CLS}`))) el.classList.remove(CLS);
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
    const wanted = new Set<Element>();
    for (const p of this.paths) {
      for (const el of Array.from(this.doc.querySelectorAll(navSelector(p)))) {
        wanted.add(el);
        if (!el.classList.contains(CLS)) el.classList.add(CLS);
      }
    }
    for (const el of Array.from(this.doc.querySelectorAll(`.${CLS}`))) {
      if (!wanted.has(el)) el.classList.remove(CLS);
    }
  }
}
