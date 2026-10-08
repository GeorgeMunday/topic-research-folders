import type { Job, Outline, SubfolderSuggestion } from "../types";
import type { Settings } from "../settings";
import type { ResearchClient } from "../research/claudeClient";
import type { VaultWriter } from "../vault/writer";
import type { Runner } from "../jobs/queue";
import { isRetryable } from "../jobs/backoff";
import { isTriggerName, strippedPath } from "../trigger";
import { uniqueName } from "../names";

export interface Approver { approve(outline: Outline): Promise<SubfolderSuggestion[] | null>; }
export interface Notifier { info(msg: string): void; error(msg: string): void; }
export interface ResearchDeps {
  client: () => ResearchClient | null;
  writer: VaultWriter;
  approver: Approver;
  notify: Notifier;
  rename: (from: string, to: string) => Promise<void>;
  settings: () => Settings;
  today: () => string;
  enqueue: (job: Job) => boolean;
  listPdfs: (folder: string) => string[];
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const parentOf = (p: string) => (p.lastIndexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : "");

export class ResearchFlow {
  private ready = false;

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

  async researchFolder(path: string): Promise<void> {
    if (!(await this.precheck(path))) return;
    this.deps.enqueue({ id: `research:${path}`, kind: "research", path, done: [] });
  }

  run: Runner = async (job, signal, checkpoint) => {
    if (job.kind !== "research") return;
    const { writer, notify, approver, settings, today } = this.deps;
    const client = this.deps.client();
    const s = settings();
    if (!client || !s.apiKey.trim()) {
      notify.error("Add your Claude API key in the plugin settings before researching a topic.");
      return;
    }
    const topic = baseName(job.path);
    // findResearchRoot looks at ancestors of the path it is given.
    const r = await writer.findResearchRoot(job.path);
    const parents = r ? [...r.parents, r.topic] : [];

    let current: Job = job;
    let outline: Outline | undefined;
    let approved = job.approved;
    if (!approved) {
      outline = await client.outline(topic, parents, s.maxSubfolders);
      const picked = await approver.approve(outline);
      if (!picked || picked.length === 0) return;
      approved = picked;
      current = { ...job, approved };
      await checkpoint(current);
    }

    const done = [...job.done];
    // Titles are known only for subfolders written in this run; resumed (already done) ones link with no note titles.
    const results = new Map<string, { subfolder: string; noteTitles: string[] }>();
    let failures = 0;
    for (const sub of approved) {
      if (done.includes(sub.name)) continue;
      if (signal.cancelled) return;
      try {
        const notes = await client.notes(topic, parents, sub, s.notesPerSubfolder);
        const res = await writer.writeSubfolder(job.path, topic, { subfolder: sub.name, notes }, today());
        results.set(sub.name, { subfolder: sub.name, noteTitles: res.noteTitles });
      } catch (err) {
        if (isRetryable(err)) throw err;
        failures++;
        notify.error(`Could not research "${sub.name}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      done.push(sub.name);
      current = { ...current, done: [...done] } as Job;
      await checkpoint(current);
    }
    if (signal.cancelled) return;

    const ov: Outline = outline ?? { topic, summary: "", subfolders: approved };
    const links = approved
      .filter((a) => results.has(a.name) || done.includes(a.name))
      .map((a) => results.get(a.name) ?? { subfolder: a.name, noteTitles: [] });
    await writer.writeOverview(job.path, ov, links, today());

    if (s.processPdfs) {
      for (const p of this.deps.listPdfs(job.path)) this.deps.enqueue({ id: `pdf:${p}`, kind: "pdf", path: p });
    }
    notify.info(`Researched ${topic}: ${links.length} subfolder${links.length === 1 ? "" : "s"}${failures ? ` (${failures} failed)` : ""}`);
  };
}
