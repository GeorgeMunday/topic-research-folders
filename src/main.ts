import { Notice, Plugin, TFile, TFolder, requestUrl } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { DEFAULT_SETTINGS, SettingsTab, mergeData } from "./settings";
import type { PluginData, Settings } from "./settings";
import type { Job } from "./types";
import { JobQueue } from "./jobs/queue";
import { ClaudeClient } from "./research/claudeClient";
import type { HttpFn } from "./research/claudeClient";
import { makeGet, makeHttp } from "./research/httpAdapter";
import { ModelCatalog } from "./models";
import type { RequestUrlResult } from "./research/httpAdapter";
import { VaultWriter } from "./vault/writer";
import type { VaultLike } from "./vault/writer";
import { ResearchFlow } from "./flows/researchFlow";
import type { Notifier } from "./flows/researchFlow";
import { PdfFlow } from "./flows/pdfFlow";
import { decideRename } from "./events";
import { ProgressTracker, RunGate, nextRunId, noticeFor, shouldOpenSession, CANCELLED_MESSAGE } from "./progress";
import type { ProgressSink } from "./progress";
import { ExplorerSpinner } from "./ui/explorerSpinner";
import { ResearchProgressModal } from "./ui/ResearchProgressModal";
import { ConfirmModal } from "./ui/ConfirmModal";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isPdfPath = (p: string) => /\.pdf$/i.test(p);

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default class TopicResearchFoldersPlugin extends Plugin {
  private data: PluginData = { settings: { ...DEFAULT_SETTINGS }, jobs: [], processedPdfs: {}, modelCache: null };
  private saveChain: Promise<void> = Promise.resolve();
  private statusEl: HTMLElement | null = null;
  private stopFns: Array<() => void> = [];

  private persist(): Promise<void> {
    this.saveChain = this.saveChain
      .then(() => this.saveData(this.data))
      .catch((e) => { console.error("Topic Research Folders: could not save plugin data", e instanceof Error ? e.message : "unknown error"); });
    return this.saveChain;
  }

  async onload(): Promise<void> {
    this.data = mergeData(await this.loadData());
    const settings = (): Settings => this.data.settings;

    const http: HttpFn = makeHttp((p) => requestUrl(p) as unknown as Promise<RequestUrlResult>);

    const vault = this.app.vault;
    const vaultLike: VaultLike = {
      exists: (p) => vault.getAbstractFileByPath(p) != null,
      read: async (p) => {
        const f = vault.getAbstractFileByPath(p);
        if (!(f instanceof TFile)) throw new Error(`Not a file: ${p}`);
        return vault.cachedRead(f);
      },
      createFolder: async (p) => { await vault.createFolder(p); },
      createFile: async (p, c) => { await vault.create(p, c); },
      children: (p) => {
        const folder = p === "" ? vault.getRoot() : vault.getAbstractFileByPath(p);
        if (!(folder instanceof TFolder)) return [];
        return folder.children.map((c) => ({ name: c.name, isFolder: c instanceof TFolder }));
      },
    };
    const writer = new VaultWriter(vaultLike);

    const listPdfs = (folder: string): string[] => {
      const root = vault.getAbstractFileByPath(folder);
      const out: string[] = [];
      const walk = (f: TFolder) => {
        for (const c of f.children) {
          if (c instanceof TFolder) walk(c);
          else if (c instanceof TFile && c.extension.toLowerCase() === "pdf") out.push(c.path);
        }
      };
      if (root instanceof TFolder) walk(root);
      return out;
    };

    const openModals = new Set<{ close: () => void }>();
    const timers = new Set<number>();
    let ready = false;
    const fail = (e: unknown) => { new Notice(`Research problem: ${e instanceof Error ? e.message : "unexpected error"}`, 10000); };
    const guard = (p: Promise<unknown>) => { p.catch(fail); };
    const needReady = (): boolean => {
      if (ready) return true;
      new Notice("Obsidian is still loading. Try again in a moment.");
      return false;
    };

    const notify: Notifier = {
      info: (m) => { new Notice(m); },
      error: (m) => { new Notice(m, 10000); },
    };

    const clientFor = () => {
      const s = settings();
      if (!s.apiKey.trim()) return null;
      return new ClaudeClient(http, () => {
        const c = settings();
        return { apiKey: c.apiKey, model: c.model, useWebSearch: c.useWebSearch };
      });
    };

    // Declared before the flows; the flows only call it after construction.
    // eslint-disable-next-line prefer-const
    let researchFlow: ResearchFlow;
    // eslint-disable-next-line prefer-const
    let pdfFlow: PdfFlow;

    const tracker = new ProgressTracker();
    const spinner = new ExplorerSpinner(document);
    const statusRQ = { r: 0, q: 0 };
    const updateStatus = () => {
      if (!this.statusEl) return;
      const suffix = tracker.statusSuffix();
      const hidden = statusRQ.r + statusRQ.q === 0 && suffix === "";
      this.statusEl.setText(hidden ? "" : `Research: ${statusRQ.r}/${statusRQ.q}${suffix ? ` · ${suffix}` : ""}`);
      this.statusEl.style.display = hidden ? "none" : "";
    };
    tracker.onChange(() => { updateStatus(); spinner.set(tracker.active()); });

    const gate = new RunGate();
    // Jobs restored from data.json: they stay silent at startup (no modal from their first step).
    const restoredPaths = new Set<string>();
    let unloaded = false;
    const sessions = new Map<string, ResearchProgressModal>();
    const noticed = new Set<string>();
    const dropSession = (path: string, s: ResearchProgressModal) => {
      if (sessions.get(path) === s) sessions.delete(path);
      openModals.delete(s);
    };
    const createSession = (path: string): ResearchProgressModal => {
      const session: ResearchProgressModal = new ResearchProgressModal(this.app, baseName(path), {
        onCancel: () => { queue.cancelJob("research", path); gate.cancel(path); researchFlow.endRun(path); tracker.clear(path); dropSession(path, session); },
        onRetry: () => { dropSession(path, session); guard(researchFlow.researchFolder(path)); },
        onClosed: () => { if (session.isDone()) dropSession(path, session); },
      });
      sessions.set(path, session);
      openModals.add(session);
      return session;
    };

    const sink: ProgressSink = (path, e, src) => {
      if (unloaded || !gate.accept(path, e, src)) return;
      tracker.handle(path, e, src);
      if (src.kind !== "research") return;
      let session = sessions.get(path);
      if (e.kind === "step" && !src.resumed) {
        if (session?.isDone()) { const old = session; dropSession(path, old); old.forceClose(); session = undefined; }
        if (shouldOpenSession({ resumed: src.resumed, restored: restoredPaths.has(path), hasSession: !!session })) { session = createSession(path); session.open(); }
      }
      session?.handle(e);
      const note = noticeFor(path, e, src, { modalOpen: session?.isVisible() ?? false, topic: baseName(path) });
      if (note) {
        const run = src.runId ?? path;
        const key = e.kind === "itemDone" ? `${run}|item|${e.name}` : `${run}|end`;
        if (!noticed.has(key)) {
          noticed.add(key);
          if (note.error) notify.error(note.text); else notify.info(note.text);
        }
      }
      if (e.kind === "done" || e.kind === "failed") {
        restoredPaths.delete(path);
        if (session && !session.isVisible()) dropSession(path, session);
      }
    };

    const queue = new JobQueue(
      async (job, signal, checkpoint) => {
        if (job.kind === "research") return researchFlow.run(job, signal, checkpoint);
        if (!settings().processPdfs) return;
        return pdfFlow.run(job, signal, checkpoint);
      },
      {
        maxConcurrent: () => settings().maxConcurrent,
        maxRetries: () => settings().maxRetries,
        persist: async (jobs: Job[]) => {
          this.data.jobs = jobs;
          await this.persist();
        },
        sleep: (ms) => new Promise<void>((res) => window.setTimeout(res, ms)),
        rand: Math.random,
        onChange: (r, q) => {
          statusRQ.r = r;
          statusRQ.q = q;
          // After a loading-state Cancel the status bar can stay at 1/0 until the in-flight HTTP call returns.
          if (r + q === 0) tracker.clear();
          updateStatus();
        },
        onFailed: (job, err) => {
          pdfFlow.dropCache(job.path);
          const msg = err instanceof Error ? err.message : "unexpected error";
          // Reuse the run id the flow used so a failed it already sent is deduplicated; the queue gave up, so forget any pending retry.
          const runId = (gate.live(job.path) ? gate.currentRun(job.path) : undefined) ?? nextRunId();
          if (job.kind === "research") researchFlow.endRun(job.path); else pdfFlow.endRun(job.path);
          sink(job.path, { kind: "failed", error: msg }, { kind: job.kind, resumed: job.kind === "research" && !!job.approved, runId });
          if (job.kind === "pdf") notify.error(`Research job failed (${job.kind}: ${job.path}): ${msg}`);
        },
        onPersistError: (e) => {
          console.error("Topic Research Folders: could not persist jobs", e instanceof Error ? e.message : "unknown error");
        },
      },
    );

    researchFlow = new ResearchFlow({
      client: clientFor,
      writer,
      approver: { approve: (o, jobPath) => (sessions.get(jobPath) ?? createSession(jobPath)).approve(o, jobPath) },
      progress: sink,
      later: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); },
      notify,
      rename: async (from, to) => {
        const f = vault.getAbstractFileByPath(from);
        if (f) await this.app.fileManager.renameFile(f, to);
      },
      settings,
      today: localDate,
      enqueue: (j) => queue.add(j),
      listPdfs,
      queuePdfs: (paths) => pdfFlow.queuePaths(paths, { force: false }),
    });

    pdfFlow = new PdfFlow({
      client: clientFor,
      writer,
      notify,
      progress: sink,
      confirm: { confirm: (msg) => { const m = new ConfirmModal(this.app); openModals.add(m); return m.confirm(msg).finally(() => openModals.delete(m)); } },
      readBinary: async (p) => {
        const f = vault.getAbstractFileByPath(p);
        if (!(f instanceof TFile)) throw new Error(`Not a file: ${p}`);
        return vault.readBinary(f);
      },
      settings,
      today: localDate,
      enqueue: (j) => queue.add(j),
      processed: () => this.data.processedPdfs,
      markProcessed: async (hash, path) => {
        this.data.processedPdfs[hash] = { path, date: localDate() };
        await this.persist();
      },
      forget: async (hash) => {
        if (!(hash in this.data.processedPdfs)) return;
        delete this.data.processedPdfs[hash];
        await this.persist();
      },
      setTimer: (fn, ms) => {
        const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
        timers.add(id);
      },
    });

    const catalog = new ModelCatalog({
      get: makeGet((p) => requestUrl(p) as unknown as Promise<RequestUrlResult>),
      apiKey: () => settings().apiKey,
      cache: () => this.data.modelCache,
      saveCache: async (c) => { this.data.modelCache = c; await this.persist(); },
      clearCache: async () => { this.data.modelCache = null; await this.persist(); },
      now: Date.now,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    this.addSettingTab(new SettingsTab(this.app, this, { settings, save: () => this.persist(), catalog }));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("");
    this.statusEl.style.display = "none";

    const onCreated = (f: TAbstractFile) => {
      if (f instanceof TFolder) guard(researchFlow.onFolderEvent(f.path));
      else if (f instanceof TFile && isPdfPath(f.path) && settings().processPdfs) guard(pdfFlow.onFileEvent(f.path));
    };
    this.registerEvent(vault.on("create", onCreated));
    this.registerEvent(vault.on("rename", (f, oldPath) => {
      const d = decideRename({ isFolder: f instanceof TFolder, oldPath, newPath: f.path, processed: this.data.processedPdfs });
      if (d.action === "folder-event") guard(researchFlow.onFolderEvent(d.path));
      else if (d.action === "update-processed") {
        const e = this.data.processedPdfs[d.hash];
        if (e) { e.path = d.path; guard(this.persist()); }
      } else if (d.action === "pdf-event" && settings().processPdfs) guard(pdfFlow.onFileEvent(d.path));
    }));

    const parentOfActive = (): string | null => {
      const file = this.app.workspace.getActiveFile();
      if (!file || !file.parent) return null;
      return file.parent.path === "/" ? "" : file.parent.path;
    };

    this.addCommand({
      id: "research-this-folder",
      name: "Research this folder",
      callback: () => {
        if (!needReady()) return;
        const folder = parentOfActive();
        if (!folder) { new Notice("Open a note inside the folder you want to research."); return; }
        guard(researchFlow.researchFolder(folder));
      },
    });

    this.addCommand({
      id: "analyse-pdfs-in-this-folder",
      name: "Analyse PDFs in this folder",
      callback: async () => {
        if (!needReady()) return;
        try {
        const folder = parentOfActive();
        if (!folder) { new Notice("Open a note inside the researched folder."); return; }
        const root = await writer.findResearchRoot(`${folder}/x.pdf`);
        if (!root) { new Notice("This folder is not inside a researched topic."); return; }
        await pdfFlow.queuePaths(listPdfs(root.root), { force: true });
        } catch (e) { fail(e); }
      },
    });

    this.addCommand({
      id: "cancel-all-research-jobs",
      name: "Cancel all research jobs",
      callback: () => {
        if (!needReady()) return;
        queue.cancelAll();
        pdfFlow.dropCache();
        for (const path of new Set([...tracker.active(), ...sessions.keys()])) gate.cancel(path);
        for (const [path, s] of [...sessions]) { s.handle({ kind: "failed", error: CANCELLED_MESSAGE }); dropSession(path, s); }
        researchFlow.endRun();
        pdfFlow.endRun();
        tracker.clear();
        new Notice("Cancelled all research jobs.");
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder) || file.path === "/" || file.isRoot()) return;
        menu.addItem((item) =>
          item.setTitle("Research this folder").setIcon("search").onClick(() => { if (needReady()) guard(researchFlow.researchFolder(file.path)); }));
      }),
    );

    const resumed = [...this.data.jobs];
    for (const j of resumed) if (j.kind === "research") restoredPaths.add(j.path);
    this.stopFns = [
      () => queue.shutdown(),
      () => catalog.dispose(),
      () => { for (const t of timers) window.clearTimeout(t); timers.clear(); },
      () => { unloaded = true; },
      () => spinner.stop(),
      () => tracker.clear(),
      () => { for (const [path, s] of [...sessions]) { dropSession(path, s); s.forceClose(); } },
      () => { for (const m of [...openModals]) m.close(); },
    ];

    // Nothing is enqueued from vault events until the layout is ready (avoids startup create-event storms).
    this.registerEvent(this.app.workspace.on("layout-change", () => spinner.reattach()));
    this.app.workspace.onLayoutReady(() => {
      ready = true;
      spinner.reattach();
      spinner.set(tracker.active());
      researchFlow.markReady();
      pdfFlow.markReady();
      queue.restore(resumed);
    });
  }

  // Deliberately no queue.cancelAll() here: it persists [] and would wipe the resume list.
  // shutdown() stops work without persisting, so data.json keeps the resume list.
  onunload(): void {
    for (const f of this.stopFns) { try { f(); } catch { /* ignore */ } }
    this.stopFns = [];
  }
}
