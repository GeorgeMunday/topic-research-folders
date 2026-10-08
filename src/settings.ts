import { PluginSettingTab, Setting } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { Job } from "./types";

export interface Settings {
  apiKey: string;
  model: string;
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
  processedPdfs: Record<string, { path: string; date: string }>;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "claude-sonnet-5-5",
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
  return isObj(j) && typeof j.id === "string" && typeof j.path === "string" && (j.kind === "research" || j.kind === "pdf");
}

function validProcessed(raw: unknown): PluginData["processedPdfs"] {
  const out: PluginData["processedPdfs"] = {};
  if (!isObj(raw)) return out;
  for (const [hash, e] of Object.entries(raw)) {
    if (isObj(e) && typeof e.path === "string" && typeof e.date === "string") out[hash] = { path: e.path, date: e.date };
  }
  return out;
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
  if (validateSuffix(settings.triggerSuffix) !== null) settings.triggerSuffix = DEFAULT_SETTINGS.triggerSuffix;
  return {
    settings,
    jobs: Array.isArray(src.jobs) ? (src.jobs.filter(validJob) as Job[]) : [],
    processedPdfs: validProcessed(src.processedPdfs),
  };
}

export interface SettingsHost {
  settings: () => Settings;
  save: () => Promise<void>;
}

type SliderKey = "maxSubfolders" | "notesPerSubfolder" | "maxDepth" | "maxConcurrent" | "pdfPagesPerChunk" | "maxRetries";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private host: SettingsHost) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings();
    const save = () => { void this.host.save(); };
    containerEl.empty();

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Stored in this plugin's data.json inside your vault's plugin folder (not encrypted).")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-ant-...").setValue(s.apiKey).onChange((v) => { s.apiKey = v.trim(); save(); });
      });

    new Setting(containerEl).setName("Model").addText((t) =>
      t.setValue(s.model).onChange((v) => { if (v.trim()) { s.model = v.trim(); save(); } }));

    new Setting(containerEl)
      .setName("Use web search")
      .setDesc("Let Claude search the web while researching.")
      .addToggle((t) => t.setValue(s.useWebSearch).onChange((v) => { s.useWebSearch = v; save(); }));

    const suffix = new Setting(containerEl)
      .setName("Trigger suffix")
      .setDesc("A new folder whose name ends with this starts a research run.");
    const err = suffix.descEl.createDiv();
    err.style.color = "var(--text-error)";
    suffix.addText((t) =>
      t.setValue(s.triggerSuffix).onChange((v) => {
        const problem = validateSuffix(v);
        err.setText(problem ?? "");
        if (problem === null) { s.triggerSuffix = v; save(); }
      }));

    new Setting(containerEl)
      .setName("Remove suffix from folder name")
      .setDesc("Rename the folder to drop the suffix once research starts.")
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
      .setDesc("Extract notes from PDFs dropped into a researched folder.")
      .addToggle((t) => t.setValue(s.processPdfs).onChange((v) => { s.processPdfs = v; save(); }));

    slider("Pages per PDF chunk", "Large PDFs are sent in chunks of this many pages.", "pdfPagesPerChunk", 5);

    new Setting(containerEl)
      .setName("Confirm above pages")
      .setDesc("Ask before analysing a batch of PDFs with more pages than this.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s.confirmAbovePages)).onChange((v) => {
          const n = Number(v);
          if (v.trim() !== "" && Number.isFinite(n) && n >= 0) { s.confirmAbovePages = Math.floor(n); save(); }
        });
      });
  }
}
