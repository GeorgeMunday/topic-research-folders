import { describe, expect, test, vi } from "vitest";
import { ResearchFlow } from "../src/flows/researchFlow";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { buildContext, contextToPrompt } from "../src/context";
import { outlinePrompt } from "../src/research/prompts";
import { parseOutline } from "../src/research/parse";
import { normaliseLanguage } from "../src/subjects";
import { modalTitle } from "../src/ui/selection";
import { ProgressHub } from "../src/ui/hub";
import type { HubActions, HubUi } from "../src/ui/hub";
import type { Job, Outline } from "../src/types";
import type { Settings } from "../src/settings";

class MemVault implements VaultLike {
  files = new Map<string, string>();
  folders = new Set<string>();
  exists(p: string) { return this.files.has(p) || this.folders.has(p); }
  async read(p: string) { const c = this.files.get(p); if (c === undefined) throw new Error("no file " + p); return c; }
  async createFolder(p: string) { if (this.exists(p)) throw new Error("exists " + p); this.folders.add(p); }
  async createFile(p: string, c: string) { if (this.exists(p)) throw new Error("exists " + p); this.files.set(p, c); }
  children(p: string) {
    const out: { name: string; isFolder: boolean }[] = [];
    const pre = p === "" ? "" : p + "/";
    for (const f of this.files.keys()) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: false });
    for (const f of this.folders) if (f.startsWith(pre) && f !== p && !f.slice(pre.length).includes("/")) out.push({ name: f.slice(pre.length), isFolder: true });
    return out;
  }
}
const vaultWith = (...folders: string[]) => { const v = new MemVault(); for (const f of folders) v.folders.add(f); return v; };

const settings: Settings = {
  apiKey: "k", model: "m", modelChosen: false, useWebSearch: false, triggerSuffix: "+", stripSuffix: true,
  maxSubfolders: 6, notesPerSubfolder: 2, maxDepth: 5, maxConcurrent: 1, maxRetries: 0,
  processPdfs: true, pdfPagesPerChunk: 50, confirmAbovePages: 200,
};
const notify = { info: () => {}, error: () => {} };
const note = (title: string) => ({ title, summary: "s", keyPoints: ["k"], plainWords: "p" });
const sig = { cancelled: false };

/** The prompt that would be sent for the folder at `path` (plain parents, no research roots). */
async function promptFor(path: string, vault: MemVault): Promise<string> {
  const topic = path.slice(path.lastIndexOf("/") + 1);
  return outlinePrompt(topic, [], 6, contextToPrompt(await buildContext(path, vault)));
}

describe("the parent folders define what the topic means", () => {
  test("c#/intro: the prompt names the plain parent 'c#' and tells the model to read 'intro' within it", async () => {
    const p = await promptFor("c#/intro", vaultWith("c#", "c#/intro"));
    expect(p).toContain("c#");
    expect(p).toContain("The user created a folder named 'intro' inside 'c#'.");
    expect(p).toContain("Interpret the folder name as a part of its parent topics");
    expect(p).toContain("research 'intro' as it relates to 'c#', not as a general topic");
  });

  test("generic leaf names rely entirely on the parents", async () => {
    const p = await promptFor("c#/intro", vaultWith("c#", "c#/intro"));
    for (const w of ["intro", "introduction", "basics", "overview", "notes", "week 1", "chapter 2", "part 1", "advanced", "exercises"]) {
      expect(p.toLowerCase()).toContain(w);
    }
    expect(p).toMatch(/generic[^.]*parents alone/i);
  });

  test("Programming/Rust/basics: the whole chain reaches the prompt", async () => {
    const p = await promptFor("Programming/Rust/basics", vaultWith("Programming", "Programming/Rust", "Programming/Rust/basics"));
    expect(p).toContain("Programming > Rust");
    expect(p).toContain("The user created a folder named 'basics' inside 'Rust'");
  });

  test("'#' and other special characters in parent names reach the prompt unchanged", async () => {
    const p = await promptFor("C# & F#/.NET (v8)/intro", vaultWith("C# & F#", "C# & F#/.NET (v8)", "C# & F#/.NET (v8)/intro"));
    expect(p).toContain("C# & F# > .NET (v8)");
    expect(p).toContain("inside '.NET (v8)'");
  });

  test("a top-level folder with no parents is framed exactly as before", async () => {
    const v = vaultWith("Black holes");
    expect(contextToPrompt(await buildContext("Black holes", v))).toBe("");
    const p = await promptFor("Black holes", v);
    expect(p).not.toContain("The user created a folder");
    expect(p).not.toContain("Interpret the folder name");
  });

  test("the outline asks for a resolvedTopic and decides the subject from it", async () => {
    const p = await promptFor("c#/intro", vaultWith("c#", "c#/intro"));
    expect(p).toContain('"resolvedTopic"');
    expect(p).toMatch(/Introduction to C#/);
    expect(p).toMatch(/subject[^.]*resolved topic/i);
  });
});

describe("resolvedTopic", () => {
  test("parseOutline keeps it (trimmed) and tolerates its absence", () => {
    const o = parseOutline('{"topic":"intro","resolvedTopic":"  Introduction to C# ","summary":"s","subfolders":[{"name":"A","why":"w"}]}', 6);
    expect(o.resolvedTopic).toBe("Introduction to C#");
    expect(parseOutline('{"summary":"s","subfolders":[{"name":"A","why":"w"}]}', 6).resolvedTopic).toBeUndefined();
  });

  test("the modal title shows the folder name and the resolved topic", () => {
    const base = { topic: "intro", summary: "s", subfolders: [] };
    expect(modalTitle("intro", { ...base, resolvedTopic: "Introduction to C#" })).toBe("Research: intro — Introduction to C#");
    expect(modalTitle("intro", base)).toBe("Research: intro");
    expect(modalTitle("intro", { ...base, resolvedTopic: "intro" })).toBe("Research: intro");
  });

  test("the research flow sends the context, then writes the resolved topic to frontmatter and gives it to the notes prompts", async () => {
    const v = vaultWith("c#", "c#/intro");
    const outline = vi.fn(async (_t: string, _p: string[], _m: number, _c?: string): Promise<Outline> =>
      ({ topic: "intro", resolvedTopic: "Introduction to C#", summary: "s", subfolders: [{ name: "Variables", why: "w" }], subject: "coding", codeLanguage: "csharp" }));
    const notes = vi.fn(async (_t: string, _p: string[], _s: unknown, _n: number, _o?: unknown) => ({ notes: [note("n")], quiz: { questions: [], answers: [] } }));
    const flow = new ResearchFlow({
      client: () => ({ outline, notes } as any), writer: new VaultWriter(v), notify, rename: async () => {},
      settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    });
    const events: any[] = [];
    (flow as any).deps.progress = (_p: string, e: unknown) => events.push(e);
    await flow.run({ id: "r", kind: "research", path: "c#/intro", done: [] }, sig, async () => {});
    expect(outline.mock.calls[0][3]).toContain("The user created a folder named 'intro' inside 'c#'.");
    const out = events.find((e) => e.kind === "outline").outline as Outline;
    expect(out.resolvedTopic).toBe("Introduction to C#");

    const job: Job = { id: "r", kind: "research", path: "c#/intro", approved: out.subfolders, done: [], summary: out.summary, resolvedTopic: out.resolvedTopic, subject: "coding", codeLanguage: "csharp" };
    await flow.run(job, sig, async () => {});
    expect(notes.mock.calls[0][0]).toBe("Introduction to C#");
    const overview = [...v.files.entries()].find(([k]) => k.endsWith("Overview.md"))!;
    expect(overview[1]).toContain('topic: "Introduction to C#"');
    expect(overview[1]).toContain("subject: coding");
    expect(overview[1]).toContain("codeLanguage: csharp");
    const noteFile = [...v.files.entries()].find(([k]) => k.endsWith("/n.md"))!;
    expect(noteFile[1]).toContain('topic: "Introduction to C#"');
  });

  test("a top-level folder still researches as before (topic = folder name)", async () => {
    const v = vaultWith("Black holes");
    const outline = vi.fn(async (t: string): Promise<Outline> => ({ topic: t, summary: "s", subfolders: [{ name: "Horizons", why: "w" }] }));
    const notes = vi.fn(async () => ({ notes: [note("n")], quiz: { questions: [], answers: [] } }));
    const flow = new ResearchFlow({
      client: () => ({ outline, notes } as any), writer: new VaultWriter(v), notify, rename: async () => {},
      settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    });
    await flow.run({ id: "r", kind: "research", path: "Black holes", approved: [{ name: "Horizons", why: "w" }], done: [] }, sig, async () => {});
    expect((notes.mock.calls[0] as unknown[])[0]).toBe("Black holes");
    const overview = [...v.files.entries()].find(([k]) => k.endsWith("Overview.md"))!;
    expect(overview[1]).toContain('topic: "Black holes"');
  });
});

describe("Re-suggest", () => {
  test("flow.resuggest sends a new outline request that uses the edited topic and the same folder context", async () => {
    const v = vaultWith("c#", "c#/intro");
    const outline = vi.fn(async (t: string, _p: string[], _m: number, _c?: string): Promise<Outline> =>
      ({ topic: t, resolvedTopic: "C# basics", summary: "s", subfolders: [{ name: "Syntax", why: "w" }] }));
    const flow = new ResearchFlow({
      client: () => ({ outline } as any), writer: new VaultWriter(v), notify, rename: async () => {},
      settings: () => settings, today: () => "2026-10-09", enqueue: () => true,
    });
    const o = await flow.resuggest("c#/intro", "C# basics");
    expect(outline).toHaveBeenCalledTimes(1);
    expect(outline.mock.calls[0][0]).toBe("C# basics");
    expect(outline.mock.calls[0][3]).toContain("inside 'c#'");
    expect(o.resolvedTopic).toBe("C# basics");
  });

  test("the hub hands the modal a resuggest hook and stores the new outline (and persists it) for Create", async () => {
    const first: Outline = { topic: "intro", resolvedTopic: "Introductions", summary: "s", subfolders: [{ name: "Speeches", why: "w" }] };
    const second: Outline = { topic: "C# basics", resolvedTopic: "C# basics", summary: "s2", subfolders: [{ name: "Syntax", why: "w" }] };
    const hooks: { resuggest?: (t: string) => Promise<Outline> }[] = [];
    const persisted: Outline[][] = [];
    const started: Outline[] = [];
    const ui: HubUi = {
      notice: () => {}, setStatus: () => {}, setSpinners: () => {},
      reviewModal: (_o, h) => new Promise((resolve) => { hooks.push(h ?? {}); (hooks[0] as any).finish = () => resolve([{ name: "Syntax", why: "w" }]); }),
    };
    const asked: [string, string][] = [];
    const actions: HubActions = {
      startApproved: (_p, _a, o) => { started.push(o); return true; },
      pathExists: () => true,
      persistPending: (l) => { persisted.push(l.map((x) => x.outline)); },
      resuggest: async (p, t) => { asked.push([p, t]); return second; },
    };
    const hub = new ProgressHub(ui, actions);
    hub.restorePending([{ path: "c#/intro", outline: first }], []);
    const done = hub.review("c#/intro");
    await Promise.resolve();
    const got = await hooks[0].resuggest!("C# basics");
    expect(got).toBe(second);
    expect(asked).toEqual([["c#/intro", "C# basics"]]);
    expect(persisted[persisted.length - 1][0]).toBe(second);
    (hooks[0] as any).finish();
    await done;
    expect(started[0]).toBe(second);
  });
});

describe("C# code fences", () => {
  test("c# is normalised to csharp so Obsidian highlights it", () => {
    expect(normaliseLanguage("C#")).toBe("csharp");
    expect(normaliseLanguage("c++")).toBe("cpp");
    expect(normaliseLanguage("Rust")).toBe("rust");
  });
});
