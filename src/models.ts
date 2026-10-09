import { ApiError } from "./jobs/queue";
import type { GetFn } from "./research/httpAdapter";

export interface ModelInfo { id: string; display_name: string; lifecycle: "active" | "deprecated" | "retired"; created_at: string; }
export interface ModelCache { fetchedAt: string; models: ModelInfo[]; }

export const MAX_PAGES = 10;
export const CACHE_TTL_MS = 86_400_000;
export const KEY_DEBOUNCE_MS = 800;
export const DEFAULT_MODEL = "claude-sonnet-5-5";

const BASE_URL = "https://api.anthropic.com/v1/models?limit=100";
const LIFECYCLES = ["active", "deprecated", "retired"] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseModelsPage(json: unknown): { models: ModelInfo[]; hasMore: boolean; lastId: string | null } {
  if (!isObj(json)) return { models: [], hasMore: false, lastId: null };
  const models: ModelInfo[] = [];
  if (Array.isArray(json.data)) {
    for (const it of json.data) {
      if (!isObj(it) || typeof it.id !== "string" || it.id === "") continue;
      const lc = LIFECYCLES.find((l) => l === it.lifecycle) ?? "active";
      models.push({
        id: it.id,
        display_name: typeof it.display_name === "string" && it.display_name ? it.display_name : it.id,
        lifecycle: lc,
        created_at: typeof it.created_at === "string" ? it.created_at : "",
      });
    }
  }
  const lastId = typeof json.last_id === "string" && json.last_id ? json.last_id : null;
  return { models, hasMore: json.has_more === true, lastId };
}

export async function fetchAllModels(get: GetFn, apiKey: string): Promise<ModelInfo[]> {
  if (apiKey.trim() === "") throw new Error("No API key set.");
  const byId = new Map<string, ModelInfo>();
  let afterId: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url: string = afterId ? `${BASE_URL}&after_id=${encodeURIComponent(afterId)}` : BASE_URL;
    const res = await get({ url, method: "GET", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    if (res.status !== 200) {
      const msg = isObj(res.json) && isObj(res.json.error) && typeof res.json.error.message === "string" && res.json.error.message
        ? res.json.error.message : `HTTP ${res.status}`;
      throw new ApiError(msg, res.status);
    }
    const p = parseModelsPage(res.json);
    for (const mdl of p.models) if (!byId.has(mdl.id)) byId.set(mdl.id, mdl);
    if (!p.hasMore || !p.lastId) break;
    afterId = p.lastId;
  }
  return [...byId.values()];
}

function time(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Active first, then newest first; invalid dates last; ties by id. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  const rank = (m: ModelInfo) => (m.lifecycle === "active" ? 0 : 1);
  return [...models].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ta = time(a.created_at), tb = time(b.created_at);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function modelOptions(models: ModelInfo[], savedId: string):
  { options: { value: string; label: string }[]; selected: string; warning?: string } {
  const usable = sortModels(models.filter((m) => m.lifecycle !== "retired"));
  const options = usable.map((m) => ({ value: m.id, label: m.lifecycle === "deprecated" ? `${m.display_name} (deprecated)` : m.display_name }));
  if (savedId === "") {
    const firstActive = usable.find((m) => m.lifecycle === "active");
    const pick = usable.find((m) => m.id === DEFAULT_MODEL) ?? firstActive ?? usable[0];
    return { options, selected: pick ? pick.id : "" };
  }
  if (usable.some((m) => m.id === savedId)) return { options, selected: savedId };
  options.push({ value: savedId, label: `${savedId} (unavailable)` });
  return {
    options, selected: savedId,
    warning: `The saved model "${savedId}" is not available. Pick another model from the list.`,
  };
}

export function isCacheFresh(cache: ModelCache | null, now: number): boolean {
  if (!cache) return false;
  const t = Date.parse(cache.fetchedAt);
  if (Number.isNaN(t) || t > now) return false;
  return now - t < CACHE_TTL_MS;
}

export type CatalogState = { status: "nokey" | "idle" | "loading" | "ready" | "error"; models: ModelInfo[]; error?: string };

export interface CatalogDeps {
  get: GetFn;
  apiKey: () => string;
  cache: () => ModelCache | null;
  saveCache: (c: ModelCache) => Promise<void>;
  clearCache: () => Promise<void>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 401 ? `The API key was rejected: ${e.message}` : e.message;
  if (e instanceof TypeError) return `Could not reach the Anthropic API (offline?): ${e.message}`;
  return e instanceof Error ? e.message : "Could not load the model list.";
}

export class ModelCatalog {
  private s: CatalogState;
  private subs = new Set<(s: CatalogState) => void>();
  private gen = 0;
  private timer: number | null = null;
  private inflight = false;
  private dropped = false;
  private disposed = false;

  constructor(private deps: CatalogDeps) {
    this.s = this.hasKey() ? { status: "idle", models: deps.cache()?.models ?? [] } : { status: "nokey", models: [] };
  }

  private hasKey(): boolean { return this.deps.apiKey().trim() !== ""; }

  private cached(): ModelCache | null { return this.dropped ? null : this.deps.cache(); }

  private set(s: CatalogState): void {
    if (this.disposed) return;
    this.s = s;
    for (const fn of [...this.subs]) fn(s);
  }

  state(): CatalogState { return this.s; }

  subscribe(fn: (s: CatalogState) => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  ensure(): void {
    if (!this.hasKey()) { this.gen++; this.inflight = false; this.set({ status: "nokey", models: [] }); return; }
    if (this.inflight || this.timer !== null) return; // a pending debounce timer will refresh
    const cache = this.cached();
    if (cache && isCacheFresh(cache, this.deps.now())) { this.set({ status: "ready", models: cache.models }); return; }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const my = ++this.gen;
    if (!this.hasKey()) { this.inflight = false; this.set({ status: "nokey", models: [] }); return; }
    this.inflight = true;
    this.set({ status: "loading", models: this.cached()?.models ?? [] });
    try {
      const models = await fetchAllModels(this.deps.get, this.deps.apiKey());
      if (my !== this.gen) return;
      this.inflight = false;
      this.dropped = false;
      const cache: ModelCache = { fetchedAt: new Date(this.deps.now()).toISOString(), models };
      this.set({ status: "ready", models });
      try { await this.deps.saveCache(cache); } catch { /* cache save failures are ignored */ }
    } catch (e) {
      if (my !== this.gen) return;
      this.inflight = false;
      this.set({ status: "error", models: this.cached()?.models ?? [], error: errorText(e) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
  }

  keyChanged(): void {
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
    this.gen++;
    this.inflight = false;
    this.dropped = true;
    void this.deps.clearCache().catch(() => { /* ignore */ });
    if (!this.hasKey()) { this.set({ status: "nokey", models: [] }); return; }
    this.set({ status: "idle", models: [] });
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.refresh(); }, KEY_DEBOUNCE_MS);
  }
}

export interface PickerView {
  disabled: boolean; spinning: boolean; options: { value: string; label: string }[];
  selected: string; hint?: string; error?: string; warning?: string;
}

export function pickerView(state: CatalogState, savedId: string): PickerView {
  const justSaved = savedId ? [{ value: savedId, label: savedId }] : [];
  const fromModels = (): ReturnType<typeof modelOptions> => modelOptions(state.models, savedId);
  if (state.status === "nokey") {
    return { disabled: true, spinning: false, options: justSaved, selected: savedId, hint: "Add your API key to load models" };
  }
  if (state.status === "loading") {
    return { disabled: true, spinning: true, options: [{ value: "", label: "Loading models…" }], selected: "" };
  }
  if (state.models.length === 0 && state.status === "ready") {
    return { disabled: true, spinning: false, options: justSaved, selected: savedId, hint: "No models available for this API key" };
  }
  if (state.models.length === 0) {
    return { disabled: true, spinning: false, options: justSaved, selected: savedId, error: state.status === "error" ? state.error : undefined };
  }
  const o = fromModels();
  if (state.status === "error") return { disabled: false, spinning: false, options: o.options, selected: o.selected, error: state.error };
  return { disabled: false, spinning: false, options: o.options, selected: o.selected, warning: o.warning };
}
