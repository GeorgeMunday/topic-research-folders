import type { ExtractedNote, Job, PdfExtraction } from "../types";
import type { Settings } from "../settings";
import type { ResearchClient } from "../research/claudeClient";
import type { VaultWriter } from "../vault/writer";
import type { Runner } from "../jobs/queue";
import type { Notifier } from "./researchFlow";
import { isRetryable } from "../jobs/backoff";
import { PdfError, inspectPdf, sha256, splitPdf } from "../pdf/chunk";

export interface Confirmer { confirm(message: string): Promise<boolean>; }
export interface PdfDeps {
  client: () => ResearchClient | null;
  writer: VaultWriter;
  notify: Notifier;
  confirm: Confirmer;
  readBinary: (path: string) => Promise<ArrayBuffer>;
  settings: () => Settings;
  today: () => string;
  enqueue: (job: Job) => boolean;
  processed: () => Record<string, { path: string; date: string }>;
  markProcessed: (hash: string, path: string) => Promise<void>;
  forget: (hash: string) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => void;
}

interface Entry { path: string; hash: string; pageCount: number; error?: "encrypted" | "unreadable"; }

const DEBOUNCE_MS = 2000;
const MAX_CHUNK_BYTES = 20_000_000;
const MAX_KEY_POINTS = 10;
const RESERVED = new Set(["from pdfs", "sources"]);

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isPdf = (p: string) => /\.pdf$/i.test(p);

function mergePages(a: string, b: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of `${a},${b}`.split(",")) {
    const t = part.trim();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out.join(", ");
}

function mergeExtractions(results: PdfExtraction[]): PdfExtraction {
  const notes: ExtractedNote[] = [];
  const index = new Map<string, ExtractedNote>();
  for (const r of results) {
    for (const n of r.notes) {
      const key = `${n.subfolder.toLowerCase()}\u0000${n.title.toLowerCase()}`;
      const existing = index.get(key);
      if (!existing) {
        const copy = { ...n, keyPoints: [...n.keyPoints] };
        index.set(key, copy);
        notes.push(copy);
        continue;
      }
      for (const k of n.keyPoints) if (!existing.keyPoints.includes(k)) existing.keyPoints.push(k);
      existing.pages = mergePages(existing.pages, n.pages);
    }
  }
  for (const n of notes) n.keyPoints = n.keyPoints.slice(0, MAX_KEY_POINTS);
  const sums = results.map((r) => r.summary).filter((s) => s !== "");
  const summary = sums.every((s) => s === sums[0]) ? (sums[0] ?? "") : sums.join(" ");
  return { summary, notes };
}

export class PdfFlow {
  private ready = false;
  private pending: Entry[] = [];
  private pendingHashes = new Set<string>();
  private inFlight = new Set<string>();
  private eventChain: Promise<unknown> = Promise.resolve();
  private flushChain: Promise<unknown> = Promise.resolve();
  private timerGen = 0;

  constructor(private deps: PdfDeps) {}

  markReady(): void { this.ready = true; }

  /** Resolves once all queued event work and flushes have settled (used by tests). */
  async idle(): Promise<void> {
    for (;;) {
      const e = this.eventChain;
      const f = this.flushChain;
      await Promise.all([e, f]);
      if (e === this.eventChain && f === this.flushChain) return;
    }
  }

  async onFileEvent(path: string): Promise<void> {
    if (!this.ready || !isPdf(path)) return;
    return this.serial(() => this.consider(path, false));
  }

  async queuePaths(paths: string[], opts: { force: boolean }): Promise<void> {
    for (const p of paths) {
      if (!isPdf(p)) continue;
      await this.serial(() => this.consider(p, opts.force));
    }
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const p = this.eventChain.then(fn).catch(() => {});
    this.eventChain = p;
    return p;
  }

  private async consider(path: string, force: boolean): Promise<void> {
    const { writer, readBinary, forget, processed } = this.deps;
    if (!(await writer.findResearchRoot(path))) return;
    let bytes: ArrayBuffer;
    try { bytes = await readBinary(path); } catch { return; }
    const hash = await sha256(bytes);
    if (force) await forget(hash);
    if (processed()[hash] || this.inFlight.has(hash) || this.pendingHashes.has(hash)) return;
    const entry: Entry = { path, hash, pageCount: 0 };
    try {
      entry.pageCount = (await inspectPdf(bytes)).pageCount;
    } catch (e) {
      entry.error = e instanceof PdfError ? e.reason : "unreadable";
    }
    this.pending.push(entry);
    this.pendingHashes.add(hash);
    this.schedule();
  }

  private schedule(): void {
    const gen = ++this.timerGen;
    this.deps.setTimer(() => {
      if (gen !== this.timerGen) return;
      this.flushChain = this.flushChain.then(() => this.flush()).catch(() => {});
    }, DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    const { notify, confirm, settings, enqueue } = this.deps;
    try {
      const good: Entry[] = [];
      for (const e of batch) {
        if (e.error) notify.error(`Skipped ${baseName(e.path)}: the PDF is ${e.error}.`);
        else good.push(e);
      }
      if (good.length === 0) return;
      const total = good.reduce((n, e) => n + e.pageCount, 0);
      if (total > settings().confirmAbovePages) {
        const msg = `Analyse ${good.length} PDF${good.length === 1 ? "" : "s"} (${total} pages in total)? ` +
          `That is ${good.length} PDFs and ${total} pages to send to Claude, which can use a lot of API credit.`;
        let ok = false;
        try { ok = await confirm.confirm(msg); } catch { ok = false; }
        if (!ok) return;
      }
      for (const e of good) enqueue({ id: `pdf:${e.path}`, kind: "pdf", path: e.path });
    } finally {
      for (const e of batch) this.pendingHashes.delete(e.hash);
    }
  }

  run: Runner = async (job) => {
    const { readBinary, processed, notify, writer, settings, today, markProcessed } = this.deps;
    let bytes: ArrayBuffer;
    try { bytes = await readBinary(job.path); } catch { return; }
    const hash = await sha256(bytes);
    if (processed()[hash] || this.inFlight.has(hash)) return;
    this.inFlight.add(hash);
    try {
      const file = baseName(job.path);
      const client = this.deps.client();
      if (!client || !settings().apiKey.trim()) {
        notify.error("Add your Claude API key in the plugin settings before analysing PDFs.");
        return;
      }
      const root = await writer.findResearchRoot(job.path);
      if (!root) return;
      const subfolders = writer.listSubfolders(root.root).filter((n) => !RESERVED.has(n.toLowerCase()));

      let split: Awaited<ReturnType<typeof splitPdf>>;
      try {
        split = await splitPdf(bytes, settings().pdfPagesPerChunk, MAX_CHUNK_BYTES);
      } catch (e) {
        if (e instanceof PdfError) {
          notify.error(`Could not analyse ${file}: the PDF is ${e.reason}.`);
          return;
        }
        throw e;
      }
      if (split.skippedPages.length > 0) {
        notify.error(`${file}: skipped page${split.skippedPages.length === 1 ? "" : "s"} ${split.skippedPages.join(", ")} (too large to send).`);
      }
      if (split.chunks.length === 0) return;

      const results: PdfExtraction[] = [];
      for (const chunk of split.chunks) {
        try {
          results.push(await client.extractPdf(root.topic, subfolders, chunk.base64, chunk.firstPage - 1));
        } catch (e) {
          if (isRetryable(e)) throw e;
          notify.error(`Could not analyse ${file}: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      const merged = mergeExtractions(results);
      await writer.writeExtracted(root.root, root.topic, file, merged, today());
      await markProcessed(hash, job.path);
      notify.info(`Extracted ${merged.notes.length} notes from ${file}`);
    } finally {
      this.inFlight.delete(hash);
    }
  };
}
