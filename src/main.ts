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
import { SuggestionModal } from "./ui/SuggestionModal";
import { ConfirmModal } from "./ui/ConfirmModal";

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
          if (!this.statusEl) return;
          this.statusEl.setText(r + q === 0 ? "" : `Research: ${r}/${q}`);
          this.statusEl.style.display = r + q === 0 ? "none" : "";
        },
        onFailed: (job, err) => {
          pdfFlow.dropCache(job.path);
          notify.error(`Research job failed (${job.kind}: ${job.path}): ${err instanceof Error ? err.message : "unexpected error"}`);
        },
        onPersistError: (e) => {
          console.error("Topic Research Folders: could not persist jobs", e instanceof Error ? e.message : "unknown error");
        },
      },
    );

    researchFlow = new ResearchFlow({
      client: clientFor,
      writer,
      approver: { approve: (o) => { const m = new SuggestionModal(this.app); openModals.add(m); return m.approve(o).finally(() => openModals.delete(m)); } },
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
    this.stopFns = [
      () => queue.shutdown(),
      () => { for (const t of timers) window.clearTimeout(t); timers.clear(); },
      () => { for (const m of [...openModals]) m.close(); },
    ];

    // Nothing is enqueued from vault events until the layout is ready (avoids startup create-event storms).
    this.app.workspace.onLayoutReady(() => {
      ready = true;
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
