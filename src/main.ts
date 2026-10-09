import { Menu, Notice, Plugin, TFile, TFolder, addIcon, requestUrl, setIcon } from "obsidian";
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
import { PdfFlow, markResumed } from "./flows/pdfFlow";
import { KeypointFlow } from "./flows/keypointFlow";
import { decideRename } from "./events";
import { ProgressHub } from "./ui/hub";
import { ExplorerSpinner } from "./ui/explorerSpinner";
import { SuggestionModal } from "./ui/SuggestionModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { ICON_ID, ICON_SVG_INNER } from "./icon";
import { ribbonItems } from "./ui/ribbon";
import type { MenuItem } from "./ui/ribbon";

const ERROR_NOTICE_MS = 10000;
// Long enough to reach the Review button.
const ACTION_NOTICE_MS = 20000;

function localDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default class TopicResearchFoldersPlugin extends Plugin {
  private data: PluginData = { settings: { ...DEFAULT_SETTINGS }, jobs: [], processedPdfs: {}, modelCache: null, pendingReviews: [] };
  private saveChain: Promise<void> = Promise.resolve();
  private statusEl: HTMLElement | null = null;
  private statusTextEl: HTMLElement | null = null;
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

    const openModals = new Set<{ close: () => void }>();
    let ready = false;
    const fail = (e: unknown) => { new Notice(`Research problem: ${e instanceof Error ? e.message : "unexpected error"}`, ERROR_NOTICE_MS); };
    const guard = (p: Promise<unknown>) => { p.catch(fail); };
    const needReady = (): boolean => {
      if (ready) return true;
      new Notice("Obsidian is still loading. Try again in a moment.");
      return false;
    };

    const notify: Notifier = {
      info: (m) => { new Notice(m); },
      error: (m) => { new Notice(m, ERROR_NOTICE_MS); },
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
    // eslint-disable-next-line prefer-const
    let keypointFlow: KeypointFlow;
    // eslint-disable-next-line prefer-const
    let queue: JobQueue;

    const spinner = new ExplorerSpinner(document);

    const showNotice = (text: string, opts?: { error?: boolean; action?: { label: string; run: () => void } }) => {
      if (opts?.action) {
        const action = opts.action;
        const frag = document.createDocumentFragment();
        const label = document.createElement("span");
        label.textContent = `${text} `;
        frag.appendChild(label);
        const button = document.createElement("button");
        button.textContent = action.label;
        frag.appendChild(button);
        const n = new Notice(frag, ACTION_NOTICE_MS);
        button.addEventListener("click", (ev) => {
          ev.stopPropagation();
          n.hide();
          try { action.run(); } catch (e) { fail(e); }
        });
        return;
      }
      if (opts?.error) new Notice(text, ERROR_NOTICE_MS);
      else new Notice(text);
    };

    // The single place that turns flow and queue events into notices, status text and spinners.
    const hub = new ProgressHub(
      {
        notice: showNotice,
        // The icon stays; only the text comes and goes.
        setStatus: (text) => {
          if (!this.statusTextEl) return;
          this.statusTextEl.setText(text);
          this.statusTextEl.toggle(text !== "");
        },
        setSpinners: (paths) => spinner.set(paths),
        reviewModal: (outline) => {
          const m = new SuggestionModal(this.app, outline);
          openModals.add(m);
          return m.choose().finally(() => openModals.delete(m));
        },
      },
      {
        startApproved: (path, approved, outline) =>
          queue.add({
            id: `research:${path}`, kind: "research", path, approved, done: [], summary: outline.summary,
            ...(outline.subject ? { subject: outline.subject } : {}), ...(outline.codeLanguage ? { codeLanguage: outline.codeLanguage } : {}),
          }),
        pathExists: (path) => vault.getAbstractFileByPath(path) != null,
        // The queue side of "Cancel all" (command and status bar menu); the hub clears its own state after it.
        cancelAllJobs: () => {
          queue.cancelAll();
          pdfFlow.dropCache();
          researchFlow.endRun();
          pdfFlow.endRun();
          keypointFlow.endRun();
        },
        persistPending: (list) => {
          this.data.pendingReviews = list;
          guard(this.persist());
        },
      },
    );

    queue = new JobQueue(
      async (job, signal, checkpoint) => {
        if (job.kind === "research") return researchFlow.run(job, signal, checkpoint);
        // Both PDF stages (the overview and the key point jobs) follow the "Analyse PDFs" setting.
        if (!settings().processPdfs) return;
        if (job.kind === "keypoint") return keypointFlow.run(job, signal, checkpoint);
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
        onChange: (r, q) => hub.onQueueChange(r, q),
        onFailed: (job, err) => {
          // The queue gave up, so forget any pending retry; the hub decides the notice (and dedupes it).
          // A key point's events (and so the hub's failure) are keyed by its entry note path; the hub maps that to the folder spinner.
          if (job.kind === "research") researchFlow.endRun(job.path);
          else if (job.kind === "keypoint") keypointFlow.endRun(job.path);
          else { pdfFlow.dropCache(job.path); pdfFlow.endRun(job.path); }
          hub.onQueueFailed(job, err);
        },
        onPersistError: (e) => {
          console.error("Topic Research Folders: could not persist jobs", e instanceof Error ? e.message : "unknown error");
        },
      },
    );

    researchFlow = new ResearchFlow({
      client: clientFor,
      writer,
      progress: hub.sink,
      later: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); },
      notify,
      rename: async (from, to) => {
        const f = vault.getAbstractFileByPath(from);
        if (f) await this.app.fileManager.renameFile(f, to);
      },
      settings,
      today: localDate,
      enqueue: (j) => queue.add(j),
    });

    pdfFlow = new PdfFlow({
      client: clientFor,
      writer,
      notify,
      progress: hub.sink,
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
      now: Date.now,
      markProcessed: async (hash, path) => {
        this.data.processedPdfs[hash] = { path, date: localDate(), at: Date.now() };
        await this.persist();
      },
      rename: async (from, to) => {
        const f = vault.getAbstractFileByPath(from);
        if (f) await this.app.fileManager.renameFile(f, to);
      },
    });

    keypointFlow = new KeypointFlow({
      client: clientFor,
      writer,
      notify,
      progress: hub.sink,
      settings,
      today: localDate,
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

    addIcon(ICON_ID, ICON_SVG_INNER);

    const openSettings = () => {
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      if (!setting) { new Notice("Open Settings, then Community plugins, then Topic Research Folders."); return; }
      setting.open();
      setting.openTabById(this.manifest.id);
    };
    // The same three entries behind the ribbon button and (when nothing is busy) the status bar item.
    const menuEntries = (): MenuItem[] => ribbonItems({
      review: () => { if (needReady()) guard(hub.review()); },
      cancelAll: () => { if (needReady()) hub.cancelEverything(); },
      openSettings,
    }, fail);
    const showMenu = (items: MenuItem[], evt: MouseEvent) => {
      const menu = new Menu();
      for (const it of items) menu.addItem((m) => m.setTitle(it.label).onClick(() => { try { it.run(); } catch (e) { fail(e); } }));
      menu.showAtMouseEvent(evt);
    };
    this.addRibbonIcon(ICON_ID, "Topic Research Folders", (evt) => showMenu(menuEntries(), evt));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("trf-status");
    this.statusEl.setAttribute("aria-label", "Topic Research Folders");
    setIcon(this.statusEl.createSpan({ cls: "trf-status-icon" }), ICON_ID);
    this.statusTextEl = this.statusEl.createSpan({ cls: "trf-status-text" });
    this.statusTextEl.hide();
    // While jobs run or reviews wait, clicking offers Cancel all / Review; otherwise the full menu.
    this.registerDomEvent(this.statusEl, "click", (evt) => {
      const items = hub.menuItems();
      showMenu(items.length > 0 ? items : menuEntries(), evt);
    });

    const onCreated = (f: TAbstractFile) => {
      if (f instanceof TFolder) guard(researchFlow.onFolderEvent(f.path));
      // Every file: the PDF flow only acts on a trigger name (cheap string check otherwise).
      else if (f instanceof TFile && settings().processPdfs) guard(pdfFlow.onFileEvent(f.path));
    };
    this.registerEvent(vault.on("create", onCreated));
    // A pending review follows its folder when it is renamed and goes away (quietly) when it is deleted.
    this.registerEvent(vault.on("delete", (f) => { if (f instanceof TFolder) hub.dropPending(f.path); }));
    this.registerEvent(vault.on("rename", (f, oldPath) => {
      if (f instanceof TFolder) hub.renamePending(oldPath, f.path);
      const d = decideRename({ isFolder: f instanceof TFolder, oldPath, newPath: f.path, suffix: settings().triggerSuffix });
      if (d.action === "folder-event") guard(researchFlow.onFolderEvent(d.path));
      else if (d.action === "pdf-event" && settings().processPdfs) guard(pdfFlow.onFileEvent(d.path));
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
        guard(researchFlow.researchFolder(folder, { force: true }));
      },
    });

    this.addCommand({
      id: "review-pending-suggestions",
      name: "Review pending suggestions",
      callback: () => {
        if (!needReady()) return;
        guard(hub.review());
      },
    });

    this.addCommand({
      id: "cancel-all-research-jobs",
      name: "Cancel all research jobs",
      callback: () => {
        if (!needReady()) return;
        // Same path as the status bar menu: stop the jobs, then clear reviews, spinners and status (neutral notice).
        hub.cancelEverything();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder) || file.path === "/" || file.isRoot()) return;
        menu.addItem((item) =>
          item.setTitle("Research this folder").setIcon("search").onClick(() => { if (needReady()) guard(researchFlow.researchFolder(file.path, { force: true })); }));
      }),
    );

    // Restored pdf jobs may be skipped if their content finished before the restart; new triggers never are.
    const resumed = markResumed(this.data.jobs);
    this.stopFns = [
      () => queue.shutdown(),
      // Before the modals close: a review closed by unload must not count as a cancel (keeps pendingReviews).
      () => hub.dispose(),
      () => catalog.dispose(),
      () => spinner.stop(),
      () => { for (const m of [...openModals]) m.close(); },
    ];

    // Nothing is enqueued from vault events until the layout is ready (avoids startup create-event storms).
    // No modal opens at startup: restored reviews only get a notice with a Review button.
    this.registerEvent(this.app.workspace.on("layout-change", () => spinner.reattach()));
    this.app.workspace.onLayoutReady(() => {
      ready = true;
      spinner.reattach();
      researchFlow.markReady();
      pdfFlow.markReady();
      hub.restorePending(this.data.pendingReviews, resumed);
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
