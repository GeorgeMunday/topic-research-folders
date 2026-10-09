import type { Job, Outline, Progress } from "../types";
import { ALREADY_RESEARCHED_MESSAGE, CANCELLED_MESSAGE, nextRunId, OUTLINE_STAGE_MS, type ProgressSink, type ProgressSource } from "../progress";
import type { Settings } from "../settings";
import type { ResearchClient } from "../research/claudeClient";
import type { VaultWriter } from "../vault/writer";
import type { Runner } from "../jobs/queue";
import { isRetryable } from "../jobs/backoff";
import { isTriggerName, strippedPath } from "../trigger";
import { uniqueName } from "../names";

export interface Notifier { info(msg: string): void; error(msg: string): void; }
export interface ResearchDeps {
  client: () => ResearchClient | null;
  writer: VaultWriter;
  notify: Notifier;
  rename: (from: string, to: string) => Promise<void>;
  settings: () => Settings;
  today: () => string;
  enqueue: (job: Job) => boolean;
  listPdfs: (folder: string) => string[];
  queuePdfs: (paths: string[]) => Promise<void>;
  progress?: ProgressSink;
  /** Schedules fn after ms; returns a function that cancels it. */
  later?: (fn: () => void, ms: number) => () => void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.lastIndexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "");

export class ResearchFlow {
  private ready = false;
  private lastRun = new Map<string, number>();
  // Paths whose last invocation ended in a retryable rethrow: the queue's retry is the same logical run.
  private retryPending = new Set<string>();

  constructor(private deps: ResearchDeps) {}

  markReady(): void { this.ready = true; }

  // Cheap checks only (key, depth); O(folder depth). Returns false after notifying.
  private async precheck(path: string): Promise<boolean> {
    const { settings, notify, writer } = this.deps;
    const s = settings();
    if (!s.apiKey.trim()) {
      notify.error("Add your Claude API key in the plugin settings before researching a topic.");
      return false;
    }
    const r = await writer.findResearchRoot(path);
    const depth = (r ? r.parents.length + 1 : 0) + 1;
    if (depth > s.maxDepth) {
      notify.error(`Not researching "${baseName(path)}": nesting would be ${depth} levels deep (limit ${s.maxDepth}).`);
      return false;
    }
    return true;
  }

  async onFolderEvent(path: string): Promise<void> {
    if (!this.ready) return;
    if (this.deps.writer.consumeCreated(path)) return;
    const s = this.deps.settings();
    if (!isTriggerName(baseName(path), s.triggerSuffix)) return;
    if (!(await this.precheck(path))) return;
    let finalPath = path;
    if (s.stripSuffix) {
      const stripped = strippedPath(path, s.triggerSuffix);
      const parent = parentOf(path);
      const siblings = new Set(this.deps.writer.listSubfolders(parent).map((n) => n.toLowerCase()));
      const name = uniqueName(baseName(stripped), (c) => siblings.has(c.toLowerCase()));
      finalPath = parent ? `${parent}/${name}` : name;
      await this.deps.rename(path, finalPath);
    }
    await this.researchFolder(finalPath);
  }

  /** force: re-run even when the folder is already researched (explicit "Research this folder"). */
  async researchFolder(path: string, opts?: { force?: boolean }): Promise<void> {
    if (!(await this.precheck(path))) return;
    const job: Job = { id: `research:${path}`, kind: "research", path, done: [] };
    if (opts?.force) job.force = true;
    const queued = this.deps.enqueue(job);
    // A queued job may wait a long time for a slot; give the UI something to show right away.
    if (queued) this.deps.progress?.(path, { kind: "step", text: "Waiting for other jobs…" }, { kind: "research", resumed: false });
  }

  /** Forget a pending retry (the queue gave up or the job was cancelled) so the next run gets a fresh id. */
  endRun(path?: string): void {
    if (path === undefined) this.retryPending.clear(); else this.retryPending.delete(path);
  }

  run: Runner = async (job, signal, checkpoint) => {
    if (job.kind !== "research") return;
    const { writer, notify, settings, today, progress, later } = this.deps;
    const resumed = Boolean(job.approved);
    let runId: number;
    const prev = this.lastRun.get(job.path);
    if (this.retryPending.delete(job.path) && prev !== undefined) runId = prev;
    else { runId = nextRunId(); this.lastRun.set(job.path, runId); }
    const src: ProgressSource = { kind: "research", resumed, runId };
    const emit = (e: Progress) => { if (progress) progress(job.path, e, src); };
    const finish = (e: Progress & { kind: "done" | "failed" }) => emit(e);
    const cancelled = () => finish({ kind: "failed", error: CANCELLED_MESSAGE });
    const retrying = (err: unknown) => { if (isRetryable(err) && !signal.cancelled) { this.retryPending.add(job.path); emit({ kind: "step", text: "Retrying after a temporary error…" }); } };
    // Pre-start exits: the sink gets a terminal failed with the notice text; otherwise the notice itself.
    const reject = (msg: string, level: "info" | "error") => {
      if (progress) finish({ kind: "failed", error: msg });
      else notify[level](msg);
    };
    const client = this.deps.client();
    const s = settings();
    if (!client || !s.apiKey.trim()) {
      reject("Add your Claude API key in the plugin settings before researching a topic.", "error");
      return;
    }
    const topic = baseName(job.path);
    // A fresh job on a folder that already is a research root (e.g. synced in, or re-triggered) would duplicate work.
    const fresh = !job.approved && job.done.length === 0;
    if (fresh && !job.force && (await writer.isResearchRoot(job.path))) {
      reject(ALREADY_RESEARCHED_MESSAGE, "info");
      return;
    }
    // findResearchRoot looks at ancestors of the path it is given.
    const r = await writer.findResearchRoot(job.path);
    const parents = r ? [...r.parents, r.topic] : [];
    if (parents.length + 1 > s.maxDepth) {
      reject(`Not researching "${topic}": nesting would be ${parents.length + 1} levels deep (limit ${s.maxDepth}).`, "error");
      return;
    }

    // Cancel-all may have landed while the checks above were awaiting.
    if (signal.cancelled) { cancelled(); return; }

    const approved = job.approved;
    if (!approved) {
      // Outline stage: deliver the suggestions and finish. The user reviews them later (Review button or
      // command), which enqueues a new job with `approved`; nothing here waits for the user.
      let outline: Outline;
      let cancelTimer: (() => void) | undefined;
      if (progress && s.useWebSearch) {
        emit({ kind: "step", text: "Searching the web…" });
        cancelTimer = later?.(() => emit({ kind: "step", text: "Suggesting folders…" }), OUTLINE_STAGE_MS);
      } else {
        emit({ kind: "step", text: `Researching ${topic}…` });
      }
      try {
        outline = await client.outline(topic, parents, s.maxSubfolders);
      } catch (err) {
        if (!progress) throw err;
        if (isRetryable(err)) { retrying(err); throw err; }
        finish({ kind: "failed", error: err instanceof Error ? err.message : String(err) });
        return;
      } finally {
        cancelTimer?.();
      }
      if (signal.cancelled) { cancelled(); return; }
      // No terminal event: the hub keeps the path pending until the review ends.
      emit({ kind: "outline", outline });
      return;
    }
    emit({ kind: "step", text: "Resuming research…" });
    let current: Job = job;

    const done = [...job.done];
    // Titles are known only for subfolders written in this run; resumed (already done) ones link with no note titles.
    const results = new Map<string, { subfolder: string; noteTitles: string[]; folder?: string }>();
    let failures = 0;
    let written = 0;
    let notesWritten = 0;
    for (const [i, sub] of approved.entries()) {
      if (done.includes(sub.name)) continue;
      if (signal.cancelled) { cancelled(); return; }
      emit({ kind: "writing", index: i + 1, total: approved.length, name: sub.name });
      try {
        const notes = await client.notes(topic, parents, sub, s.notesPerSubfolder);
        const res = await writer.writeSubfolder(job.path, topic, { subfolder: sub.name, notes }, today());
        results.set(sub.name, { subfolder: baseName(res.folder), noteTitles: res.noteTitles, folder: res.folder });
        written++;
        notesWritten += res.noteTitles.length;
      } catch (err) {
        if (isRetryable(err)) { retrying(err); throw err; }
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        if (!progress) notify.error(`Could not research "${sub.name}": ${msg}`);
        emit({ kind: "itemDone", name: sub.name, ok: false, error: msg });
        continue;
      }
      emit({ kind: "itemDone", name: sub.name, ok: true });
      done.push(sub.name);
      current = { ...current, done: [...done] } as Job;
      await checkpoint(current);
    }
    if (signal.cancelled) { cancelled(); return; }

    if (written + job.done.length === 0) {
      const msg = "No subfolders could be written";
      if (progress) finish({ kind: "failed", error: msg });
      else notify.error(msg);
      return;
    }

    const ov: Outline = { topic, summary: job.summary ?? "", subfolders: approved };
    const links = approved
      .filter((a) => results.has(a.name) || done.includes(a.name))
      .map((a) => results.get(a.name) ?? { subfolder: a.name, noteTitles: [] });
    try {
      await writer.writeOverview(job.path, ov, links, today());

      if (s.processPdfs) {
        const pdfs = this.deps.listPdfs(job.path);
        if (pdfs.length > 0) await this.deps.queuePdfs(pdfs);
      }
    } catch (err) {
      retrying(err);
      if (!isRetryable(err)) finish({ kind: "failed", error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (progress) finish({ kind: "done", folders: written + job.done.length, notes: notesWritten });
    else notify.info(`Researched ${topic}: ${links.length} subfolder${links.length === 1 ? "" : "s"}${failures ? ` (${failures} failed)` : ""}`);
  };
}
