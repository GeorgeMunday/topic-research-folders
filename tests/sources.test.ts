import { describe, expect, test } from "vitest";
import { extractSources, MAX_SOURCES, pageLabel } from "../src/research/sources";
import { ClaudeClient, type HttpFn } from "../src/research/claudeClient";
import { renderNote } from "../src/vault/noteTemplate";
import { VaultWriter, type VaultLike } from "../src/vault/writer";
import { KeypointFlow } from "../src/flows/keypointFlow";
import type { Job, NoteContent } from "../src/types";
import type { Settings } from "../src/settings";

const cite = (url: string, title: string) => ({ type: "web_search_result_location", url, title, cited_text: "x" });
const result = (url: string, title: string) => ({ type: "web_search_result", url, title, page_age: "1 day" });

describe("extractSources: only what the API returned", () => {
  test("cited URLs of the text blocks, in order", () => {
    const json = { content: [
      { type: "text", text: "searching" },
      { type: "text", text: "{}", citations: [cite("https://a.example/x", "Page A"), cite("https://b.example/y", "Page B")] },
    ] };
    expect(extractSources(json)).toEqual([{ title: "Page A", url: "https://a.example/x" }, { title: "Page B", url: "https://b.example/y" }]);
  });

  test("falls back to the web_search_tool_result blocks when nothing is cited", () => {
    const json = { content: [{ type: "web_search_tool_result", tool_use_id: "t", content: [result("https://a.example/", "A"), result("https://b.example/", "B")] }, { type: "text", text: "{}" }] };
    expect(extractSources(json).map((s) => s.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  test("a failed search result (an error object, not a list) gives nothing", () => {
    const json = { content: [{ type: "web_search_tool_result", tool_use_id: "t", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }] };
    expect(extractSources(json)).toEqual([]);
  });

  test("never takes URLs written in the model's text", () => {
    const json = { content: [{ type: "text", text: "See https://invented.example/page and [x](https://also-invented.example) {\"a\":1}" }] };
    expect(extractSources(json)).toEqual([]);
  });

  test("deduplicates by URL (ignoring a fragment and trailing slash), keeping the first title", () => {
    const json = { content: [{ type: "text", text: "{}", citations: [cite("https://a.example/x", "First"), cite("https://a.example/x#part", "Again"), cite("https://a.example/x/", "Slash")] }] };
    expect(extractSources(json)).toEqual([{ title: "First", url: "https://a.example/x" }]);
  });

  test("keeps at most 5", () => {
    const cites = Array.from({ length: 9 }, (_, i) => cite(`https://s${i}.example/`, `S${i}`));
    const got = extractSources({ content: [{ type: "text", text: "{}", citations: cites }] });
    expect(MAX_SOURCES).toBe(5);
    expect(got.map((s) => s.title)).toEqual(["S0", "S1", "S2", "S3", "S4"]);
  });

  test("only http(s) URLs; titles are one line without brackets; a missing title falls back to the host", () => {
    const json = { content: [{ type: "text", text: "{}", citations: [
      cite("javascript:alert(1)", "bad"), cite("ftp://x.example/f", "ftp"), { type: "web_search_result_location", title: "no url" },
      cite("https://ok.example/p(1)", "A [weird]\n title"), cite("https://untitled.example/z", ""),
    ] }] };
    expect(extractSources(json)).toEqual([
      { title: "A weird title", url: "https://ok.example/p(1%29" },
      { title: "untitled.example", url: "https://untitled.example/z" },
    ]);
  });

  test("garbage input is no sources", () => {
    expect(extractSources(null)).toEqual([]);
    expect(extractSources({ content: "nope" })).toEqual([]);
    expect(extractSources({ content: [null, 1, { type: "text" }] })).toEqual([]);
  });
});

describe("the client attaches real sources to each note of a call", () => {
  const NOTES = JSON.stringify({ notes: [{ title: "A", summary: "s", keyPoints: ["k"], plainWords: "p" }, { title: "B", summary: "s", keyPoints: ["k"], plainWords: "p" }], questions: [], answers: [] });
  const cfg = () => ({ apiKey: "k", model: "m", useWebSearch: true });
  test("with citations", async () => {
    const http: HttpFn = async () => ({ status: 200, headers: {}, json: { content: [{ type: "text", text: NOTES, citations: [cite("https://a.example/", "A page")] }] } });
    const r = await new ClaudeClient(http, cfg).notes("T", [], { name: "S", why: "w" }, 2);
    expect(r.notes.map((n) => n.sources)).toEqual([[{ title: "A page", url: "https://a.example/" }], [{ title: "A page", url: "https://a.example/" }]]);
  });
  test("without any: the notes carry no sources field at all", async () => {
    const http: HttpFn = async () => ({ status: 200, headers: {}, json: { content: [{ type: "text", text: NOTES }] } });
    const r = await new ClaudeClient(http, cfg).notes("T", [], { name: "S", why: "w" }, 2);
    expect(r.notes.every((n) => !("sources" in n))).toBe(true);
  });
});

describe("the Sources section of a note", () => {
  const base: NoteContent = { title: "N", summary: "s", keyPoints: ["k"], plainWords: "p" };
  const ctx = { topic: "T", subtopic: "S", date: "2026-10-09" };
  test("comes last, after My notes, as a list of links", () => {
    const md = renderNote({ ...base, sources: [{ title: "Page A", url: "https://a.example/x" }, { title: "Page B", url: "https://b.example/" }] }, ctx);
    expect(md.endsWith("## My notes\n\n- \n\n## Sources\n\n- [Page A](https://a.example/x)\n- [Page B](https://b.example/)\n")).toBe(true);
  });
  test("is omitted when there are no sources", () => {
    expect(renderNote(base, ctx)).not.toContain("## Sources");
    expect(renderNote({ ...base, sources: [] }, ctx)).not.toContain("## Sources");
    expect(renderNote(base, ctx).endsWith("## My notes\n\n- \n")).toBe(true);
  });
  test("a PDF-derived note lists the PDF with its pages, never web links", () => {
    const md = renderNote({ ...base, sources: [{ title: "Web", url: "https://a.example/" }] }, { ...ctx, source: "paper.pdf", pages: "3-5" });
    expect(md.endsWith("## Sources\n\n- [[paper.pdf]] (p. 3–5)\n")).toBe(true);
    expect(md).not.toContain("a.example");
  });
  test("page labels", () => {
    expect(pageLabel("3-5")).toBe(" (p. 3–5)");
    expect(pageLabel("7")).toBe(" (p. 7)");
    expect(pageLabel("1, 4-6")).toBe(" (p. 1, 4–6)");
    expect(pageLabel("")).toBe("");
    expect(pageLabel(undefined)).toBe("");
  });
});

describe("key point notes cite the PDF", () => {
  class Mem implements VaultLike {
    files = new Map<string, string>(); folders = new Set<string>();
    exists(p: string) { return this.files.has(p) || this.folders.has(p); }
    async read(p: string) { return this.files.get(p) ?? ""; }
    async createFolder(p: string) { this.folders.add(p); }
    async createFile(p: string, c: string) { this.files.set(p, c); }
    children() { return []; }
  }
  const settings = { apiKey: "k", notesPerSubfolder: 2 } as unknown as Settings;
  test("even when web search returned sources", async () => {
    const v = new Mem();
    const notes = [{ title: "N", summary: "s", keyPoints: ["k"], plainWords: "p", sources: [{ title: "Web", url: "https://a.example/" }] }];
    const flow = new KeypointFlow({
      client: () => ({ notes: async () => ({ notes, quiz: { questions: [], answers: [] } }) } as any),
      writer: new VaultWriter(v), notify: { info() {}, error() {} }, settings: () => settings, today: () => "2026-10-09",
    });
    const job: Job = { id: "k", kind: "keypoint", path: "P/Idea.md", folder: "P/Idea", pdfName: "paper.pdf", topic: "paper", parents: [], point: { name: "Idea", text: "t (p. 3)", detail: "d", pages: "3-5" } };
    await flow.run(job, { cancelled: false }, async () => {});
    const note = [...v.files.entries()].find(([k]) => k.endsWith("/N.md"))![1];
    expect(note).toContain("## Sources\n\n- [[paper.pdf]] (p. 3–5)");
    expect(note).not.toContain("a.example");
  });
});
