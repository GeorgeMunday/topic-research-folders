import type { ExtractedNote, Job, PdfExtraction, Progress } from "../types";
import type { Settings } from "../settings";
import type { ResearchClient } from "../research/claudeClient";
import type { VaultWriter } from "../vault/writer";
import type { Runner } from "../jobs/queue";
import type { Notifier } from "./researchFlow";
import { isRetryable } from "../jobs/backoff";
import { CANCELLED_MESSAGE, nextRunId, type ProgressSink } from "../progress";
import { PdfError, inspectPdf, sha256, splitPdf } from "../pdf/chunk";
import { containerFor, pdfTriggerName } from "../pdf/trigger";
import { uniqueName } from "../names";

/** Marks pdf jobs restored from data.json: only those may be skipped because their content was processed before. */
export function markResumed(jobs: Job[]): Job[] {
  return jobs.map((j) => (j.kind === "pdf" ? { ...j, resume: true } : j));
}

export interface PdfPlan {
  /** Folder that receives the output: the research root, or `<dir>/<stem>` for a PDF outside any root. */
  container: string;
  /** True when the container becomes a new research root (the PDF is not inside one). */
  asRoot: boolean;
  root: { root: string; topic: string; parents: string[] } | null;
}

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
  processed: () => Record<string, { path: string; date: string; at?: number }>;
  markProcessed: (hash: string, path: string) => Promise<void>;
  /** Clock (ms epoch) used to stamp triggered jobs; defaults to Date.now. */
  now?: () => number;
  /** Renames a vault file (used to strip the trigger suffix). */
  rename: (from: string, to: string) => Promise<void>;
  progress?: ProgressSink;
}

const MAX_CHUNK_BYTES = 20_000_000;
const MAX_KEY_POINTS = 10;
const RESERVED = new Set(["from pdfs", "sources"]);

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.lastIndexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "");

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
  private inFlight = new Set<string>();
  // Trigger paths being handled right now: create and rename events for one file can arrive together.
  private triggering = new Set<string>();
  // Paths produced by our own suffix-stripping rename whose clean name is itself a trigger name
  // (`C++.pdf` -> `C+.pdf`): the rename event for them is consumed once and ignored.
  private ownRenames = new Set<string>();
  private lastRun = new Map<string, number>();
  private retryPending = new Set<string>();
  // Completed chunk results per file hash, kept across retry attempts so a retry does not resend them.
  private chunkCache = new Map<string, Map<number, PdfExtraction>>();
  private cacheHashByPath = new Map<string, string>();

  constructor(private deps: PdfDeps) {}

  markReady(): void { this.ready = true; }

  /**
   * Called for every file create/rename (never for folders). Only a trigger name (`paper+.pdf`,
   * `paper.pdf+`) does anything; everything else returns after a little string work.
   */
  async onFileEvent(path: string): Promise<void> {
    if (this.ownRenames.delete(path)) return;
    if (!this.ready) return;
    const t = pdfTriggerName(baseName(path), this.deps.settings().triggerSuffix);
    if (!t || this.triggering.has(path)) return;
    this.triggering.add(path);
    try {
      await this.trigger(path, t.clean);
    } catch (e) {
      this.failAt(path, e instanceof Error ? e.message : "unexpected error");
    } finally {
      this.triggering.delete(path);
    }
  }

  private async trigger(path: string, clean: string): Promise<void> {
    const { readBinary, settings, writer, rename, enqueue, confirm } = this.deps;
    let bytes: ArrayBuffer;
    // Missing (e.g. a late duplicate event after the rename) or unreadable: nothing to do.
    try { bytes = await readBinary(path); } catch { return; }
    let finalPath = path;
    if (settings().stripSuffix) {
      const dir = parentOf(path);
      const taken = new Set(writer.listNames(dir).map((n) => n.toLowerCase()));
      const ext = clean.slice(-4);
      const stem = uniqueName(clean.slice(0, -4), (c) => taken.has(`${c}${ext}`.toLowerCase()));
      finalPath = dir ? `${dir}/${stem}${ext}` : `${stem}${ext}`;
      // Recorded before the await: the vault's rename event can fire during the call.
      const own = pdfTriggerName(`${stem}${ext}`, settings().triggerSuffix) !== null;
      if (own) this.ownRenames.add(finalPath);
      try {
        await rename(path, finalPath);
      } catch (e) {
        if (own) this.ownRenames.delete(finalPath);
        throw e;
      }
    }
    let pages: number;
    try {
      pages = (await inspectPdf(bytes)).pageCount;
    } catch (e) {
      this.failAt(finalPath, `the PDF is ${e instanceof PdfError ? e.reason : "unreadable"}`);
      return;
    }
    // Each trigger is confirmed on its own (no batching); declined leaves the file renamed and queues nothing.
    if (pages > settings().confirmAbovePages) {
      const msg = `Analyse ${baseName(finalPath)} (${pages} pages)? This sends it to Claude and can use a lot of API credit.`;
      let ok = false;
      try { ok = await confirm.confirm(msg); } catch { ok = false; }
      if (!ok) return;
    }
    enqueue({ id: `pdf:${finalPath}`, kind: "pdf", path: finalPath, triggeredAt: (this.deps.now ?? Date.now)() });
  }

  /** A trigger-time failure: the sink gets a failed event with the bare reason, otherwise a notice. */
  private failAt(path: string, reason: string): void {
    try {
      if (this.deps.progress) this.deps.progress(path, { kind: "failed", error: reason }, { kind: "pdf", resumed: false, runId: nextRunId() });
      else this.deps.notify.error(`Could not analyse ${baseName(path)}: ${reason}`);
    } catch { /* ignore */ }
  }

  /** Decides where the output of the PDF at `pdfPath` goes. */
  async plan(pdfPath: string): Promise<PdfPlan> {
    const root = await this.deps.writer.findResearchRoot(pdfPath);
    return { ...containerFor(pdfPath, root), root };
  }

  /** Forget cached chunk results for one job path (or all, with no argument), e.g. when a job is dropped. */
  dropCache(path?: string): void {
    if (path === undefined) { this.chunkCache.clear(); this.cacheHashByPath.clear(); return; }
    const h = this.cacheHashByPath.get(path);
    if (h !== undefined) this.chunkCache.delete(h);
    this.cacheHashByPath.delete(path);
  }

  endRun(path?: string): void {
    if (path === undefined) this.retryPending.clear(); else this.retryPending.delete(path);
  }

  run: Runner = async (job, signal) => {
    const { readBinary, processed, notify, writer, settings, today, markProcessed } = this.deps;
    let bytes: ArrayBuffer;
    try { bytes = await readBinary(job.path); } catch { return; }
    const hash = await sha256(bytes);
    // An explicit trigger always runs. A job restored after a restart is skipped only when this content finished
    // processing at or after the job was triggered (it completed before the queue could save); entries without
    // `at` (older data) never cause a skip.
    const at = processed()[hash]?.at;
    const finished = job.kind === "pdf" && job.resume === true && typeof at === "number" && at >= (job.triggeredAt ?? 0);
    if (finished || this.inFlight.has(hash)) return;
    if (signal.cancelled) return;
    this.inFlight.add(hash);
    let runId: number;
    const prev = this.lastRun.get(job.path);
    if (this.retryPending.delete(job.path) && prev !== undefined) runId = prev;
    else { runId = nextRunId(); this.lastRun.set(job.path, runId); }
    const src = { kind: "pdf" as const, resumed: false, runId };
    const emit = (e: Progress) => this.deps.progress?.(job.path, e, src);
    const fail = (error: string) => emit({ kind: "failed", error });
    // Outcomes go only through the sink when there is one: the failed event carries the bare reason and the
    // hub adds "Could not analyse <file>: ". Without a sink the full message is a notice (`plain` overrides it).
    const report = (reason: string, plain = `Could not analyse ${baseName(job.path)}: ${reason}`) => {
      if (this.deps.progress) fail(reason); else notify.error(plain);
    };
    // Cached chunk results survive only a retryable failure; every other exit clears them.
    let keep = false;
    try {
      const file = baseName(job.path);
      emit({ kind: "step", text: `Preparing ${file}…` });
      const client = this.deps.client();
      if (!client || !settings().apiKey.trim()) {
        report("no Claude API key — add it in the plugin settings", "Add your Claude API key in the plugin settings before analysing PDFs.");
        return;
      }
      const plan = await this.plan(job.path);
      const root = plan.root;
      // A PDF outside any root gets its own folder (plan.container) once the overview writer exists (Task 18).
      if (plan.asRoot || !root) { report("it is not inside a researched folder"); return; }
      const subfolders = writer.listSubfolders(root.root).filter((n) => !RESERVED.has(n.toLowerCase()));

      let split: Awaited<ReturnType<typeof splitPdf>>;
      try {
        split = await splitPdf(bytes, settings().pdfPagesPerChunk, MAX_CHUNK_BYTES);
      } catch (e) {
        if (e instanceof PdfError) {
          report(`the PDF is ${e.reason}.`);
          return;
        }
        fail(e instanceof Error ? e.message : String(e));
        throw e;
      }
      if (split.skippedPages.length > 0) {
        notify.error(`${file}: skipped page${split.skippedPages.length === 1 ? "" : "s"} ${split.skippedPages.join(", ")} (too large to send).`);
      }
      if (split.chunks.length === 0) { fail("it has no pages that can be sent"); return; }

      let done = this.chunkCache.get(hash);
      if (!done) { done = new Map(); this.chunkCache.set(hash, done); }
      this.cacheHashByPath.set(job.path, hash);
      const results: PdfExtraction[] = [];
      for (const [i, chunk] of split.chunks.entries()) {
        if (signal.cancelled) { keep = false; fail(CANCELLED_MESSAGE); return; }
        const cached = done.get(i);
        if (cached) { results.push(cached); continue; }
        emit({ kind: "step", text: `Analysing ${file} (chunk ${i + 1}/${split.chunks.length})…` });
        try {
          const r = await client.extractPdf(root.topic, subfolders, chunk.base64, chunk.firstPage - 1);
          done.set(i, r);
          results.push(r);
        } catch (e) {
          if (isRetryable(e)) { keep = true; if (!signal.cancelled) { this.retryPending.add(job.path); emit({ kind: "step", text: `Retrying ${file} after a temporary error…` }); } throw e; }
          report(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      if (signal.cancelled) { fail(CANCELLED_MESSAGE); return; }
      const merged = mergeExtractions(results);
      let written: Awaited<ReturnType<typeof writer.writeExtracted>>;
      try {
        written = await writer.writeExtracted(root.root, root.topic, file, merged, today());
        await markProcessed(hash, job.path);
      } catch (e) {
        if (isRetryable(e)) { if (!signal.cancelled) { this.retryPending.add(job.path); emit({ kind: "step", text: `Retrying ${file} after a temporary error…` }); } }
        else fail(e instanceof Error ? e.message : String(e));
        throw e;
      }
      emit({ kind: "done", folders: new Set(written.map((w) => w.folder)).size, notes: written.length });
      // With a sink the hub turns `done` into the notice.
      if (!this.deps.progress) notify.info(`Extracted ${merged.notes.length} notes from ${file}`);
    } finally {
      this.inFlight.delete(hash);
      if (!keep) { this.chunkCache.delete(hash); this.cacheHashByPath.delete(job.path); }
    }
  };
}
