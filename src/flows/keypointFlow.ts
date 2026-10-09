import type { Progress } from "../types";
import type { Settings } from "../settings";
import type { ResearchClient } from "../research/claudeClient";
import type { VaultWriter } from "../vault/writer";
import type { Runner } from "../jobs/queue";
import type { Notifier } from "./researchFlow";
import { isRetryable } from "../jobs/backoff";
import { CANCELLED_MESSAGE, nextRunId, type ProgressSink, type ProgressSource } from "../progress";

export interface KeypointDeps {
  client: () => ResearchClient | null;
  writer: VaultWriter;
  notify: Notifier;
  settings: () => Settings;
  today: () => string;
  progress?: ProgressSink;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Stage 2 of PDF research: one queued job per key point. Researches the key point (web search per settings,
 * inside the client) with the PDF's context and writes the notes into the key point's folder. Events are
 * keyed by that folder (`ProgressSource.kind` "keypoint"); a failure concerns this key point only.
 */
export class KeypointFlow {
  private lastRun = new Map<string, number>();
  // Job paths whose last invocation ended in a retryable rethrow: the queue's retry is the same logical run.
  private retryPending = new Set<string>();

  constructor(private deps: KeypointDeps) {}

  /** Forget a pending retry (the queue gave up or the job was cancelled) so the next run gets a fresh id. */
  endRun(path?: string): void {
    if (path === undefined) this.retryPending.clear(); else this.retryPending.delete(path);
  }

  run: Runner = async (job, signal) => {
    if (job.kind !== "keypoint") return;
    const { writer, notify, settings, today, progress } = this.deps;
    let runId: number;
    const prev = this.lastRun.get(job.path);
    if (this.retryPending.delete(job.path) && prev !== undefined) runId = prev;
    else { runId = nextRunId(); this.lastRun.set(job.path, runId); }
    const src: ProgressSource = { kind: "keypoint", resumed: false, runId };
    const emit = (e: Progress) => { if (progress) progress(job.folder, e, src); };
    // With a sink the hub adds `Could not research "<folder>": `; without one the full message is a notice.
    const fail = (reason: string) => {
      if (progress) emit({ kind: "failed", error: reason });
      else if (reason === CANCELLED_MESSAGE) notify.info(reason);
      else notify.error(`Could not research "${baseName(job.folder)}": ${reason}`);
    };
    const point = job.point;
    const client = this.deps.client();
    if (!client || !settings().apiKey.trim()) {
      fail("no Claude API key — add it in the plugin settings");
      return;
    }
    if (signal.cancelled) { fail(CANCELLED_MESSAGE); return; }
    emit({ kind: "step", text: `Researching "${point.name}" (from ${job.pdfName})…` });
    try {
      const notes = await client.notes(
        job.topic,
        job.parents,
        { name: point.name, why: `${point.text} — from the PDF: ${point.detail}` },
        settings().notesPerSubfolder,
      );
      if (signal.cancelled) { fail(CANCELLED_MESSAGE); return; }
      const res = await writer.writeKeypointNotes(job.folder, job.topic, point.name, notes, today());
      emit({ kind: "done", folders: 1, notes: res.noteTitles.length });
    } catch (err) {
      if (isRetryable(err)) {
        if (!signal.cancelled) {
          this.retryPending.add(job.path);
          emit({ kind: "step", text: `Retrying "${point.name}" after a temporary error…` });
        }
        throw err;
      }
      if (signal.cancelled) { fail(CANCELLED_MESSAGE); return; }
      fail(err instanceof Error ? err.message : String(err));
    }
  };
}
