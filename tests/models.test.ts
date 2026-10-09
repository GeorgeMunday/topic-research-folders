import { describe, expect, test } from "vitest";
import {
  CACHE_TTL_MS, KEY_DEBOUNCE_MS, MAX_PAGES, ModelCatalog, fetchAllModels, isCacheFresh,
  modelOptions, parseModelsPage, pickerView, sortModels,
} from "../src/models";
import type { CatalogDeps, ModelCache, ModelInfo } from "../src/models";
import { ApiError } from "../src/jobs/queue";

const KEY = "test-key-123";
const m = (id: string, over: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, display_name: id.toUpperCase(), lifecycle: "active", created_at: "2026-01-01T00:00:00Z", ...over });

type Req = { url: string; method: "GET"; headers: Record<string, string> };
function fakeGet(pages: any[] | ((req: Req, n: number) => any)) {
  const calls: Req[] = [];
  const get = async (req: Req) => {
    calls.push(req);
    return typeof pages === "function" ? pages(req, calls.length - 1) : pages[calls.length - 1];
  };
  return { get, calls };
}
const page = (ids: string[], hasMore = false, extra: any = {}) => ({
  status: 200, headers: {},
  json: { data: ids.map((id) => ({ id, display_name: id, created_at: "2026-01-01T00:00:00Z", type: "model" })),
    has_more: hasMore, last_id: ids[ids.length - 1], ...extra },
});

describe("parseModelsPage", () => {
  test("parseModelsPage maps fields, defaults lifecycle to active, skips items without an id", () => {
    const r = parseModelsPage({
      data: [
        { id: "a", display_name: "A", created_at: "2026-02-01T00:00:00Z", lifecycle: "deprecated", deprecated_at: "x" },
        { id: "b", display_name: "B", created_at: "2026-01-01T00:00:00Z" },
        { display_name: "no id" },
        { id: 5 },
        null,
        { id: "c", display_name: "C", created_at: "2026-01-01T00:00:00Z", lifecycle: "weird" },
      ],
      has_more: true, last_id: "c",
    });
    expect(r.models).toEqual([
      { id: "a", display_name: "A", lifecycle: "deprecated", created_at: "2026-02-01T00:00:00Z" },
      { id: "b", display_name: "B", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
      { id: "c", display_name: "C", lifecycle: "active", created_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(r.hasMore).toBe(true);
    expect(r.lastId).toBe("c");
    expect(parseModelsPage(undefined)).toEqual({ models: [], hasMore: false, lastId: null });
  });
});

describe("fetchAllModels", () => {
  test("fetchAllModels sends the exact first request", async () => {
    const { get, calls } = fakeGet([page(["a"])]);
    await fetchAllModels(get, KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
  });

  test("fetchAllModels follows has_more with after_id=<last_id> and merges pages without duplicate ids", async () => {
    const { get, calls } = fakeGet([page(["a", "b"], true), page(["b", "c"], false)]);
    const out = await fetchAllModels(get, KEY);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://api.anthropic.com/v1/models?limit=100&after_id=b");
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  test("fetchAllModels stops after MAX_PAGES (10) even if has_more stays true", async () => {
    expect(MAX_PAGES).toBe(10);
    const { get, calls } = fakeGet((_r, n) => page([`m${n}`], true));
    const out = await fetchAllModels(get, KEY);
    expect(calls).toHaveLength(10);
    expect(out).toHaveLength(10);
  });

  test("non-200 -> ApiError with the status and the API message; the key is not in the message", async () => {
    const { get } = fakeGet([{ status: 401, headers: {}, json: { error: { message: "invalid x-api-key" } } }]);
    const err = await fetchAllModels(get, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("invalid x-api-key");
    expect(err.message).not.toContain(KEY);
    const { get: g2 } = fakeGet([{ status: 500, headers: {}, json: undefined }]);
    const e2 = await fetchAllModels(g2, KEY).catch((e) => e);
    expect(e2).toBeInstanceOf(ApiError);
    expect(e2.message).toBe("HTTP 500");
  });

  test("empty key throws before any request", async () => {
    const { get, calls } = fakeGet([page(["a"])]);
    await expect(fetchAllModels(get, "  ")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("sortModels / modelOptions", () => {
  test("sortModels: active first, then newest created_at first; invalid dates last", () => {
    const list = [
      m("old", { created_at: "2025-01-01T00:00:00Z" }),
      m("dep", { lifecycle: "deprecated", created_at: "2027-01-01T00:00:00Z" }),
      m("bad", { created_at: "nonsense" }),
      m("new", { created_at: "2026-06-01T00:00:00Z" }),
      m("tie-b", { created_at: "2024-01-01T00:00:00Z" }),
      m("tie-a", { created_at: "2024-01-01T00:00:00Z" }),
    ];
    expect(sortModels(list).map((x) => x.id)).toEqual(["new", "old", "tie-a", "tie-b", "bad", "dep"]);
  });

  test("modelOptions: label is display_name, ' (deprecated)' appended, retired models are not options", () => {
    const r = modelOptions([
      m("a", { display_name: "Model A" }),
      m("d", { display_name: "Model D", lifecycle: "deprecated", created_at: "2020-01-01T00:00:00Z" }),
      m("r", { display_name: "Model R", lifecycle: "retired" }),
    ], "a", true);
    expect(r.options).toEqual([{ value: "a", label: "Model A" }, { value: "d", label: "Model D (deprecated)" }]);
    expect(r.selected).toBe("a");
    expect(r.warning).toBeUndefined();
  });

  test("modelOptions: saved id missing -> extra '<id> (unavailable)' option, selected stays saved, warning says to pick another", () => {
    const r = modelOptions([m("a"), m("r", { lifecycle: "retired" })], "r", true);
    expect(r.options.map((o) => o.value)).toEqual(["a", "r"]);
    expect(r.options[1].label).toBe("r (unavailable)");
    expect(r.selected).toBe("r");
    expect(r.warning).toMatch(/pick another model/i);
    const r2 = modelOptions([m("a")], "gone", true);
    expect(r2.selected).toBe("gone");
    expect(r2.options).toContainEqual({ value: "gone", label: "gone (unavailable)" });
  });

  test("modelOptions: empty saved id -> claude-sonnet-5-5 if listed, else the first active model", () => {
    const withDefault = modelOptions([m("zzz", { created_at: "2030-01-01T00:00:00Z" }), m("claude-sonnet-5-5")], "", false);
    expect(withDefault.selected).toBe("claude-sonnet-5-5");
    expect(withDefault.warning).toBeUndefined();
    const without = modelOptions([m("old", { created_at: "2020-01-01T00:00:00Z" }), m("new", { created_at: "2030-01-01T00:00:00Z" })], "", false);
    expect(without.selected).toBe("new");
  });
  test("modelOptions: not chosen and default missing -> first active model, no warning, no unavailable option", () => {
    const r = modelOptions([m("old", { created_at: "2020-01-01T00:00:00Z" }), m("new", { created_at: "2030-01-01T00:00:00Z" })], "claude-sonnet-5-5", false);
    expect(r.selected).toBe("new");
    expect(r.warning).toBeUndefined();
    expect(r.options.map((o) => o.value)).toEqual(["new", "old"]);
  });

  test("modelOptions: chosen and missing -> '<id> (unavailable)' option and a warning (unchanged)", () => {
    const r = modelOptions([m("a")], "gone", true);
    expect(r.selected).toBe("gone");
    expect(r.options).toContainEqual({ value: "gone", label: "gone (unavailable)" });
    expect(r.warning).toMatch(/pick another model/i);
  });

  test("modelOptions: not chosen and default listed -> default selected", () => {
    const r = modelOptions([m("zzz", { created_at: "2030-01-01T00:00:00Z" }), m("claude-sonnet-5-5")], "gone", false);
    expect(r.selected).toBe("claude-sonnet-5-5");
    expect(r.warning).toBeUndefined();
  });
});

describe("isCacheFresh", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const at = (h: number): ModelCache => ({ fetchedAt: new Date(now - h * 3_600_000).toISOString(), models: [] });
  test("isCacheFresh: null false; 23h true; 25h false; unparsable or future fetchedAt false", () => {
    expect(CACHE_TTL_MS).toBe(86_400_000);
    expect(isCacheFresh(null, now)).toBe(false);
    expect(isCacheFresh(at(23), now)).toBe(true);
    expect(isCacheFresh(at(25), now)).toBe(false);
    expect(isCacheFresh({ fetchedAt: "garbage", models: [] }, now)).toBe(false);
    expect(isCacheFresh(at(-2), now)).toBe(false);
  });
});

describe("ModelCatalog", () => {
  const NOW = Date.parse("2026-10-09T12:00:00Z");
  function setup(opts: { key?: string; cache?: ModelCache | null; pages?: any[] | ((r: Req, n: number) => any) } = {}) {
    const { get, calls } = fakeGet(opts.pages ?? [page(["a", "b"])]);
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextId = 1;
    const saved: ModelCache[] = [];
    const cleared = { count: 0 };
    const ctl = { key: opts.key ?? KEY, cache: opts.cache ?? null };
    const deps: CatalogDeps = {
      get, apiKey: () => ctl.key, cache: () => ctl.cache,
      saveCache: async (c) => { saved.push(c); ctl.cache = c; },
      clearCache: async () => { cleared.count++; ctl.cache = null; },
      now: () => NOW,
      setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
      clearTimer: (id) => { timers.delete(id); },
    };
    const catalog = new ModelCatalog(deps);
    return { catalog, calls, timers, saved, ctl, cleared };
  }
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const fresh = (): ModelCache => ({ fetchedAt: new Date(NOW - 3_600_000).toISOString(), models: [m("cached")] });
  const stale = (): ModelCache => ({ fetchedAt: new Date(NOW - 30 * 3_600_000).toISOString(), models: [m("cached")] });

  test("ensure(): no key -> nokey and no request; fresh cache -> ready and no request; stale cache -> one request", async () => {
    const a = setup({ key: "" });
    a.catalog.ensure();
    await flush();
    expect(a.catalog.state().status).toBe("nokey");
    expect(a.calls).toHaveLength(0);

    const b = setup({ cache: fresh() });
    b.catalog.ensure();
    await flush();
    expect(b.catalog.state().status).toBe("ready");
    expect(b.catalog.state().models.map((x) => x.id)).toEqual(["cached"]);
    expect(b.calls).toHaveLength(0);

    const c = setup({ cache: stale() });
    c.catalog.ensure();
    await flush();
    expect(c.calls).toHaveLength(1);
    expect(c.catalog.state().status).toBe("ready");
    expect(c.catalog.state().models.map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("debounces key changes: 3 keyChanged() calls inside 800 ms -> one request, only after the timer fires", async () => {
    expect(KEY_DEBOUNCE_MS).toBe(800);
    const s = setup();
    s.catalog.keyChanged(); s.catalog.keyChanged(); s.catalog.keyChanged();
    await flush();
    expect(s.calls).toHaveLength(0);
    expect(s.timers.size).toBe(1);
    expect([...s.timers.values()][0].ms).toBe(800);
    [...s.timers.values()][0].fn();
    await flush();
    expect(s.calls).toHaveLength(1);
  });

  test("blank key -> nokey immediately and the pending timer is cleared", async () => {
    const s = setup();
    s.catalog.keyChanged();
    expect(s.timers.size).toBe(1);
    s.ctl.key = "";
    s.catalog.keyChanged();
    expect(s.catalog.state().status).toBe("nokey");
    expect(s.timers.size).toBe(0);
    expect(s.calls).toHaveLength(0);
  });

  test("ignores a stale response: refresh() twice, first resolves last -> state holds the second result", async () => {
    const resolvers: Array<(v: any) => void> = [];
    const saved: ModelCache[] = [];
    const catalog = new ModelCatalog({
      get: () => new Promise((res) => resolvers.push(res)),
      apiKey: () => KEY, cache: () => null,
      saveCache: async (c) => { saved.push(c); }, clearCache: async () => {}, now: () => NOW,
      setTimer: () => 1, clearTimer: () => {},
    });
    const p1 = catalog.refresh();
    const p2 = catalog.refresh();
    expect(catalog.state().status).toBe("loading");
    resolvers[1](page(["second"]));
    await p2;
    resolvers[0](page(["first"]));
    await p1;
    expect(catalog.state().models.map((x) => x.id)).toEqual(["second"]);
    expect(saved).toHaveLength(1);
    expect(saved[0].models.map((x) => x.id)).toEqual(["second"]);
  });

  test("error keeps cached models: state.status 'error', models = cache, error message set; success saves cache with fetchedAt ISO", async () => {
    const bad = setup({ cache: stale(), pages: [{ status: 500, headers: {}, json: { error: { message: "overloaded" } } }] });
    const seen: string[] = [];
    bad.catalog.subscribe((st) => seen.push(st.status));
    await bad.catalog.refresh();
    const st = bad.catalog.state();
    expect(st.status).toBe("error");
    expect(st.models.map((x) => x.id)).toEqual(["cached"]);
    expect(st.error).toBe("overloaded");
    expect(bad.saved).toHaveLength(0);
    expect(seen).toEqual(["loading", "error"]);

    const rej = setup({ pages: [{ status: 401, headers: {}, json: { error: { message: "invalid x-api-key" } } }] });
    await rej.catalog.refresh();
    expect(rej.catalog.state().error).toBe("The API key was rejected: invalid x-api-key");

    const ok = setup();
    await ok.catalog.refresh();
    expect(ok.saved).toHaveLength(1);
    expect(ok.saved[0].fetchedAt).toBe(new Date(NOW).toISOString());
    expect(ok.saved[0].models.map((x) => x.id)).toEqual(["a", "b"]);
    expect(JSON.stringify(ok.saved)).not.toContain(KEY);
  });

  test("offline TypeError gives a readable error message", async () => {
    const s = setup({ pages: () => { throw new TypeError("net::ERR_INTERNET_DISCONNECTED"); } });
    await s.catalog.refresh();
    expect(s.catalog.state().status).toBe("error");
    expect(s.catalog.state().error).toBe("Could not reach the Anthropic API (offline?): net::ERR_INTERNET_DISCONNECTED");
  });

  test("keyChanged() invalidates an in-flight refresh started with the old key; the new key's refresh wins", async () => {
    const resolvers: Array<(v: any) => void> = [];
    const saved: ModelCache[] = [];
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const catalog = new ModelCatalog({
      get: () => new Promise((res) => resolvers.push(res)),
      apiKey: () => KEY, cache: () => null,
      saveCache: async (c) => { saved.push(c); }, clearCache: async () => {}, now: () => NOW,
      setTimer: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
      clearTimer: (id) => { timers.delete(id); },
    });
    const p1 = catalog.refresh();
    catalog.keyChanged();
    resolvers[0](page(["old-account"]));
    await p1;
    expect(catalog.state().models).toEqual([]);
    expect(catalog.state().status).not.toBe("ready");
    expect(saved).toHaveLength(0);
    [...timers.values()][0]();
    resolvers[1](page(["new-account"]));
    await flush();
    expect(catalog.state().models.map((x) => x.id)).toEqual(["new-account"]);
    expect(saved).toHaveLength(1);
  });

  test("keyChanged() clears the cache; a failed fetch then shows an error with no models, and ensure() requests again", async () => {
    const s = setup({ cache: fresh(), pages: [{ status: 401, headers: {}, json: { error: { message: "bad" } } }, page(["a"])] });
    s.catalog.keyChanged();
    expect(s.cleared.count).toBe(1);
    [...s.timers.values()][0].fn();
    await flush();
    expect(s.catalog.state().status).toBe("error");
    expect(s.catalog.state().models).toEqual([]);
    s.catalog.ensure();
    await flush();
    expect(s.calls).toHaveLength(2);
  });

  test("keyChanged() drops in-memory models even if clearCache does not remove them", async () => {
    const catalog = new ModelCatalog({
      get: async () => ({ status: 500, headers: {}, json: undefined }),
      apiKey: () => KEY, cache: () => ({ fetchedAt: new Date(NOW - 1000).toISOString(), models: [m("old")] }),
      saveCache: async () => {}, clearCache: async () => {}, now: () => NOW,
      setTimer: () => 1, clearTimer: () => {},
    });
    catalog.keyChanged();
    expect(catalog.state().models).toEqual([]);
    await catalog.refresh();
    expect(catalog.state().status).toBe("error");
    expect(catalog.state().models).toEqual([]);
  });

  test("blank key also clears the cache", () => {
    const s = setup({ cache: fresh() });
    s.ctl.key = "";
    s.catalog.keyChanged();
    expect(s.cleared.count).toBe(1);
  });

  test("ensure() does not start a second request while one is in flight", async () => {
    const s = setup({ cache: stale() });
    s.catalog.ensure();
    s.catalog.ensure();
    await flush();
    expect(s.calls).toHaveLength(1);
  });

  test("ensure() does nothing while the key debounce timer is pending", async () => {
    const s = setup({ cache: stale() });
    s.catalog.keyChanged();
    s.catalog.ensure();
    await flush();
    expect(s.calls).toHaveLength(0);
    [...s.timers.values()][0].fn();
    await flush();
    expect(s.calls).toHaveLength(1);
  });

  test("dispose() clears the pending timer and late responses do nothing", async () => {
    const resolvers: Array<(v: any) => void> = [];
    const saved: ModelCache[] = [];
    const timers = new Map<number, () => void>();
    const catalog = new ModelCatalog({
      get: () => new Promise((res) => resolvers.push(res)),
      apiKey: () => KEY, cache: () => null,
      saveCache: async (c) => { saved.push(c); }, clearCache: async () => {}, now: () => NOW,
      setTimer: (fn) => { timers.set(1, fn); return 1; },
      clearTimer: (id) => { timers.delete(id); },
    });
    const p = catalog.refresh();
    catalog.dispose();
    const before = catalog.state();
    resolvers[0](page(["late"]));
    await p;
    expect(catalog.state()).toBe(before);
    expect(saved).toHaveLength(0);
    const c2 = new ModelCatalog({
      get: async () => page(["x"]), apiKey: () => KEY, cache: () => null,
      saveCache: async () => {}, clearCache: async () => {}, now: () => NOW,
      setTimer: (fn) => { timers.set(2, fn); return 2; }, clearTimer: (id) => { timers.delete(id); },
    });
    c2.keyChanged();
    expect(timers.has(2)).toBe(true);
    c2.dispose();
    expect(timers.has(2)).toBe(false);
  });
});

describe("pickerView", () => {
  test("pickerView: nokey -> disabled + hint 'Add your API key to load models'; loading -> disabled, spinning, single option 'Loading models…'; error -> enabled, error text, current model still selected; ready with missing saved model -> warning", () => {
    const nokey = pickerView({ status: "nokey", models: [] }, "claude-sonnet-5-5", false);
    expect(nokey.disabled).toBe(true);
    expect(nokey.hint).toBe("Add your API key to load models");
    expect(nokey.selected).toBe("claude-sonnet-5-5");

    const loading = pickerView({ status: "loading", models: [m("a")] }, "a", false);
    expect(loading.disabled).toBe(true);
    expect(loading.spinning).toBe(true);
    expect(loading.options).toEqual([{ value: "", label: "Loading models…" }]);

    const err = pickerView({ status: "error", models: [m("a"), m("b")], error: "boom" }, "b", true);
    expect(err.disabled).toBe(false);
    expect(err.spinning).toBe(false);
    expect(err.error).toBe("boom");
    expect(err.selected).toBe("b");

    const errMissing = pickerView({ status: "error", models: [m("a")], error: "boom" }, "gone", true);
    expect(errMissing.selected).toBe("gone");
    expect(errMissing.options).toContainEqual({ value: "gone", label: "gone (unavailable)" });

    const ready = pickerView({ status: "ready", models: [m("a")] }, "gone", true);
    expect(ready.disabled).toBe(false);
    expect(ready.warning).toMatch(/pick another model/i);
    expect(ready.selected).toBe("gone");

    const empty = pickerView({ status: "ready", models: [] }, "x", true);
    expect(empty.disabled).toBe(true);
    expect(empty.hint).toBe("No models available for this API key");
  });

  test("pickerView passes the chosen flag through", () => {
    const st = { status: "ready" as const, models: [m("a")] };
    const notChosen = pickerView(st, "gone", false);
    expect(notChosen.selected).toBe("a");
    expect(notChosen.warning).toBeUndefined();
    expect(notChosen.options).toEqual([{ value: "a", label: "A" }]);
    const chosen = pickerView(st, "gone", true);
    expect(chosen.selected).toBe("gone");
    expect(chosen.warning).toMatch(/pick another model/i);
    const errNot = pickerView({ status: "error", models: [m("a")], error: "boom" }, "gone", false);
    expect(errNot.selected).toBe("a");
    expect(errNot.options.some((o) => o.label.includes("unavailable"))).toBe(false);
  });
});

describe("model capabilities", () => {
  const caps = (pdf: boolean | null, web: boolean | null) => ({
    capabilities: {
      pdf_input: pdf === null ? null : { supported: pdf },
      server_tools: web === null ? null : { web_search: { supported: web } },
    },
  });

  test("parseModelsPage reads pdf and web search support only when explicitly stated", () => {
    const r = parseModelsPage({ data: [
      { id: "a", ...caps(false, false) },
      { id: "b", ...caps(true, true) },
      { id: "c", capabilities: null },
      { id: "d" },
      { id: "e", capabilities: { pdf_input: { supported: "no" } } },
    ] });
    const by = Object.fromEntries(r.models.map((x) => [x.id, x]));
    expect(by.a.pdf).toBe(false);
    expect(by.a.webSearch).toBe(false);
    expect(by.b.pdf).toBe(true);
    expect(by.b.webSearch).toBe(true);
    for (const id of ["c", "d", "e"]) { expect(by[id].pdf).toBeUndefined(); expect(by[id].webSearch).toBeUndefined(); }
  });

  test("modelOptions disables a model without PDF support and labels it", () => {
    const r = modelOptions([m("a", { display_name: "A", pdf: false }), m("b", { display_name: "B" })], "b", true, { useWebSearch: false });
    expect(r.options).toEqual([
      { value: "a", label: "A (no PDF support)", disabled: true },
      { value: "b", label: "B" },
    ]);
  });

  test("modelOptions disables a model without web search only while web search is on", () => {
    const list = [m("a", { display_name: "A", webSearch: false })];
    const on = modelOptions(list, "a", true, { useWebSearch: true });
    expect(on.options).toEqual([{ value: "a", label: "A (no web search)", disabled: true }]);
    const off = modelOptions(list, "a", true, { useWebSearch: false });
    expect(off.options).toEqual([{ value: "a", label: "A" }]);
  });

  test("modelOptions: unknown capabilities (undefined) are shown normally", () => {
    const r = modelOptions([m("a", { display_name: "A" })], "a", true, { useWebSearch: true });
    expect(r.options).toEqual([{ value: "a", label: "A" }]);
  });

  test("modelOptions: both missing -> both reasons in the label", () => {
    const r = modelOptions([m("a", { display_name: "A", pdf: false, webSearch: false })], "a", true, { useWebSearch: true });
    expect(r.options[0]).toEqual({ value: "a", label: "A (no PDF support, no web search)", disabled: true });
  });

  test("automatic selection skips disabled models", () => {
    const r = modelOptions([
      m("claude-sonnet-5-5", { pdf: false }),
      m("other", { created_at: "2020-01-01T00:00:00Z" }),
    ], "", false, { useWebSearch: false });
    expect(r.selected).toBe("other");
  });

  test("pickerView passes useWebSearch through", () => {
    const state = { status: "ready" as const, models: [m("a", { display_name: "A", webSearch: false })] };
    expect(pickerView(state, "a", true, { useWebSearch: true }).options[0].disabled).toBe(true);
    expect(pickerView(state, "a", true, { useWebSearch: false }).options[0].disabled).toBeUndefined();
  });
});
