import { PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { Job, Outline, PendingReview } from "./types";
import { modelOptions, pickerView } from "./models";
import type { ModelCache, ModelCatalog, ModelInfo } from "./models";

export interface Settings {
  apiKey: string;
  model: string;
  /** True once the user picked a model from the dropdown (an automatic selection does not count). */
  modelChosen: boolean;
  useWebSearch: boolean;
  triggerSuffix: string;
  stripSuffix: boolean;
  maxSubfolders: number;
  notesPerSubfolder: number;
  maxDepth: number;
  maxConcurrent: number;
  maxRetries: number;
  processPdfs: boolean;
  pdfPagesPerChunk: number;
  confirmAbovePages: number;
}

export interface PluginData {
  settings: Settings;
  jobs: Job[];
  /** `at`: ms epoch when processing finished (missing in older data). */
  processedPdfs: Record<string, { path: string; date: string; at?: number }>;
  modelCache: ModelCache | null;
  /** Folder suggestions waiting for review; the outline job has finished. */
  pendingReviews: PendingReview[];
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "claude-sonnet-5-5",
  modelChosen: false,
  useWebSearch: true,
  triggerSuffix: "+",
  stripSuffix: true,
  maxSubfolders: 6,
  notesPerSubfolder: 3,
  maxDepth: 3,
  maxConcurrent: 2,
  maxRetries: 4,
  processPdfs: true,
  pdfPagesPerChunk: 50,
  confirmAbovePages: 200,
};

const ILLEGAL = ["*", '"', "\\", "/", "<", ">", ":", "|", "?"];

/** Returns null when valid, otherwise a message for the user. */
export function validateSuffix(s: string): string | null {
  if (s.trim() === "") return "The suffix cannot be empty.";
  for (const c of ILLEGAL) {
    if (s.includes(c)) return `The character "${c}" is not allowed in folder names.`;
  }
  return null;
}

const RANGES: Record<string, [number, number]> = {
  maxSubfolders: [3, 8],
  notesPerSubfolder: [2, 5],
  maxDepth: [1, 5],
  maxConcurrent: [1, 5],
  pdfPagesPerChunk: [10, 100],
  maxRetries: [0, 10],
  confirmAbovePages: [0, Number.MAX_SAFE_INTEGER],
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function validJob(j: unknown): boolean {
  if (!isObj(j) || typeof j.id !== "string" || typeof j.path !== "string") return false;
  if (j.kind === "pdf") {
    return (j.resume === undefined || typeof j.resume === "boolean")
      && (j.triggeredAt === undefined || (typeof j.triggeredAt === "number" && Number.isFinite(j.triggeredAt)));
  }
  if (j.kind === "keypoint") {
    const pt = j.point;
    return typeof j.folder === "string" && typeof j.pdfName === "string" && typeof j.topic === "string"
      && Array.isArray(j.parents) && j.parents.every((x) => typeof x === "string")
      && isObj(pt) && typeof pt.name === "string" && typeof pt.text === "string"
      && typeof pt.detail === "string" && typeof pt.pages === "string"
      && (pt.subfolder === undefined || typeof pt.subfolder === "string")
      && (j.docSummary === undefined || typeof j.docSummary === "string");
  }
  if (j.kind !== "research") return false;
  if (!Array.isArray(j.done) || !j.done.every((d) => typeof d === "string")) return false;
  if (j.summary !== undefined && typeof j.summary !== "string") return false;
  if (j.approved === undefined) return true;
  return Array.isArray(j.approved) && j.approved.every((a) => isObj(a) && typeof a.name === "string");
}

function validPending(p: unknown): PendingReview | null {
  if (!isObj(p) || typeof p.path !== "string" || !isObj(p.outline)) return null;
  const o = p.outline;
  if (typeof o.topic !== "string" || typeof o.summary !== "string" || !Array.isArray(o.subfolders)) return null;
  if (!o.subfolders.every((s) => isObj(s) && typeof s.name === "string" && typeof s.why === "string")) return null;
  const outline: Outline = {
    topic: o.topic,
    summary: o.summary,
    subfolders: (o.subfolders as Record<string, unknown>[]).map((s) => ({ name: s.name as string, why: s.why as string })),
  };
  return { path: p.path, outline };
}

function validProcessed(raw: unknown): PluginData["processedPdfs"] {
  const out: PluginData["processedPdfs"] = {};
  if (!isObj(raw)) return out;
  for (const [hash, e] of Object.entries(raw)) {
    if (!isObj(e) || typeof e.path !== "string" || typeof e.date !== "string") continue;
    out[hash] = typeof e.at === "number" && Number.isFinite(e.at) ? { path: e.path, date: e.date, at: e.at } : { path: e.path, date: e.date };
  }
  return out;
}

function validModelCache(raw: unknown): ModelCache | null {
  if (!isObj(raw) || typeof raw.fetchedAt !== "string" || !Array.isArray(raw.models)) return null;
  const models: ModelInfo[] = [];
  for (const m of raw.models) {
    if (!isObj(m) || typeof m.id !== "string" || m.id === "") continue;
    if (m.lifecycle !== "active" && m.lifecycle !== "deprecated" && m.lifecycle !== "retired") continue;
    models.push({
      id: m.id,
      display_name: typeof m.display_name === "string" ? m.display_name : m.id,
      lifecycle: m.lifecycle,
      created_at: typeof m.created_at === "string" ? m.created_at : "",
      ...(typeof m.pdf === "boolean" ? { pdf: m.pdf } : {}),
      ...(typeof m.webSearch === "boolean" ? { webSearch: m.webSearch } : {}),
    });
  }
  return { fetchedAt: raw.fetchedAt, models };
}

/** Merge saved data over defaults, ignoring wrong-typed values and clamping numbers. */
export function mergeData(raw: unknown): PluginData {
  const src = isObj(raw) ? raw : {};
  const saved = isObj(src.settings) ? src.settings : {};
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const out = settings as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const def = DEFAULT_SETTINGS[key];
    const v = saved[key];
    if (typeof v !== typeof def) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      const [lo, hi] = RANGES[key];
      out[key] = Math.min(hi, Math.max(lo, v));
    } else {
      out[key] = v;
    }
  }
  // Data saved before the flag existed: a model other than the default must have been picked by the user.
  if (saved.modelChosen === undefined) settings.modelChosen = typeof saved.model === "string" && saved.model !== "" && saved.model !== DEFAULT_SETTINGS.model;
  else if (typeof saved.modelChosen !== "boolean") settings.modelChosen = false;
  if (validateSuffix(settings.triggerSuffix) !== null) settings.triggerSuffix = DEFAULT_SETTINGS.triggerSuffix;
  return {
    settings,
    jobs: Array.isArray(src.jobs) ? (src.jobs.filter(validJob) as Job[]) : [],
    processedPdfs: validProcessed(src.processedPdfs),
    modelCache: validModelCache(src.modelCache),
    pendingReviews: Array.isArray(src.pendingReviews) ? src.pendingReviews.flatMap((p) => { const v = validPending(p); return v ? [v] : []; }) : [],
  };
}

export interface SettingsHost {
  settings: () => Settings;
  save: () => Promise<void>;
  catalog: ModelCatalog;
}

type SliderKey = "maxSubfolders" | "notesPerSubfolder" | "maxDepth" | "maxConcurrent" | "pdfPagesPerChunk" | "maxRetries";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private host: SettingsHost) {
    super(app, plugin);
  }

  private unsubscribe: (() => void) | null = null;
  private rerenderModels: () => void = () => {};

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Built once; catalog changes only repopulate the select and text lines (display() would steal focus). */
  private buildModelRow(containerEl: HTMLElement, s: Settings, save: () => void): void {
    const catalog = this.host.catalog;
    const row = new Setting(containerEl).setName("Model");
    const info = row.descEl.createDiv();
    const hintEl = info.createDiv({ cls: "trf-muted" });
    const errorEl = info.createDiv({ cls: "trf-error" });
    const warnEl = info.createDiv({ cls: "trf-error" });
    let select: HTMLSelectElement | null = null;
    let setDisabled: (d: boolean) => void = () => {};
    let spinEl: HTMLElement | null = null;

    row.addDropdown((d) => {
      select = d.selectEl;
      setDisabled = (v) => { d.setDisabled(v); };
      d.onChange((v) => { if (v) { s.model = v; s.modelChosen = true; save(); } });
    });
    row.addExtraButton((b) => {
      b.setIcon("refresh-cw").setTooltip("Refresh models").onClick(() => { void catalog.refresh(); });
      spinEl = b.extraSettingsEl;
    });

    const render = () => {
      const state = catalog.state();
      if (!s.modelChosen && state.status === "ready") {
        // Automatic selection: saved without marking the model as chosen.
        const sel = modelOptions(state.models, s.model, false, { useWebSearch: s.useWebSearch }).selected;
        if (sel && sel !== s.model) { s.model = sel; save(); }
      }
      const v = pickerView(state, s.model, s.modelChosen, { useWebSearch: s.useWebSearch });
      if (select) {
        const sel: HTMLSelectElement = select;
        sel.empty();
        for (const o of v.options) {
          const opt = sel.createEl("option", { value: o.value, text: o.label });
          if (o.disabled) opt.disabled = true;
        }
        sel.value = v.selected;
      }
      setDisabled(v.disabled);
      (spinEl as HTMLElement | null)?.toggleClass("trf-spin", v.spinning);
      hintEl.setText(v.hint ?? "");
      errorEl.setText(v.error ?? "");
      warnEl.setText(v.warning ?? "");
    };
    this.unsubscribe = catalog.subscribe(render);
    this.rerenderModels = render;
    render();
    catalog.ensure();
  }

  display(): void {
    this.hide();
    const { containerEl } = this;
    const s = this.host.settings();
    const save = () => { void this.host.save(); };
    containerEl.empty();

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Stored in this plugin's data.json inside your vault's plugin folder (not encrypted).")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...").setValue(s.apiKey).onChange((v) => { s.apiKey = v.trim(); save(); this.host.catalog.keyChanged(); });
      });

    this.buildModelRow(containerEl, s, save);

    new Setting(containerEl)
      .setName("Use web search")
      .setDesc("Let Claude search the web while researching.")
      .addToggle((t) => t.setValue(s.useWebSearch).onChange((v) => { s.useWebSearch = v; save(); this.rerenderModels(); }));

    const suffix = new Setting(containerEl)
      .setName("Trigger suffix")
      .setDesc("A folder name or PDF file name ending with this starts research / analysis.");
    const err = suffix.descEl.createDiv();
    err.style.color = "var(--text-error)";
    suffix.addText((t) =>
      t.setValue(s.triggerSuffix).onChange((v) => {
        const problem = validateSuffix(v);
        err.setText(problem ?? "");
        if (problem === null) { s.triggerSuffix = v; save(); }
      }));

    new Setting(containerEl)
      .setName("Remove suffix from folder or PDF name")
      .setDesc("Rename the folder or PDF to drop the suffix once research or analysis starts.")
      .addToggle((t) => t.setValue(s.stripSuffix).onChange((v) => { s.stripSuffix = v; save(); }));

    const slider = (name: string, desc: string, key: SliderKey, step = 1) => {
      const [lo, hi] = RANGES[key];
      new Setting(containerEl).setName(name).setDesc(desc).addSlider((sl) =>
        sl.setLimits(lo, hi, step).setValue(s[key]).setDynamicTooltip().onChange((v) => { s[key] = v; save(); }));
    };
    slider("Subfolders per topic", "Maximum subfolders Claude may suggest.", "maxSubfolders");
    slider("Notes per subfolder", "How many notes to write in each subfolder.", "notesPerSubfolder");
    slider("Maximum nesting depth", "How many levels of researched folders are allowed.", "maxDepth");
    slider("Concurrent jobs", "How many research or PDF jobs run at once.", "maxConcurrent");
    slider("Retries", "Retries after rate limits or server errors.", "maxRetries");

    new Setting(containerEl)
      .setName("Analyse PDFs")
      .setDesc("Analyse PDFs whose name ends with the suffix (paper+.pdf).")
      .addToggle((t) => t.setValue(s.processPdfs).onChange((v) => { s.processPdfs = v; save(); }));

    slider("Pages per PDF chunk", "Large PDFs are sent in chunks of this many pages.", "pdfPagesPerChunk", 5);

    new Setting(containerEl)
      .setName("Confirm above pages")
      .setDesc("Ask before analysing a single PDF with more pages than this.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s.confirmAbovePages)).onChange((v) => {
          const n = Number(v);
          if (v.trim() !== "" && Number.isFinite(n) && n >= 0) { s.confirmAbovePages = Math.floor(n); save(); }
        });
      });
  }
}
