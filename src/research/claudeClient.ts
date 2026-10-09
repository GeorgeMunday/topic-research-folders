import type { Outline, NotesResult, PdfOverview, SubfolderSuggestion } from "../types";
import { outlinePrompt, notesPrompt, pdfOverviewPrompt, mergeOverviewsPrompt, type NotesOptions } from "./prompts";
import { parseOutline, parseNotes, parsePdfOverview, ParseError } from "./parse";
import { extractSources, type Source } from "./sources";
import { ApiError } from "../jobs/queue";

export interface ResearchClient {
  /** `context`: the prompt block describing the folders above the topic (see context.ts). */
  outline(topic: string, parents: string[], max: number, context?: string): Promise<Outline>;
  notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number, opts?: NotesOptions): Promise<NotesResult>;
  /** Stage 1 for one chunk: the document block first, no tools. */
  overviewPdf(pdfName: string, subfolders: string[], pdfBase64: string, pageOffset: number, context?: string): Promise<PdfOverview>;
  /** Picks the top 5 key points overall from the chunk results; text only, no document, no tools. */
  mergeOverviews(pdfName: string, candidates: PdfOverview[]): Promise<PdfOverview>;
}

export type HttpFn = (req: { url: string; method: "POST"; headers: Record<string, string>; body: string })
  => Promise<{ status: number; json: any; headers: Record<string, string> }>;

const API_URL = "https://api.anthropic.com/v1/messages";
const WEB_SEARCH = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

function lastJsonText(json: any): string {
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type === "text" && typeof b.text === "string" && b.text.includes("{")) return b.text;
  }
  throw new ParseError("No JSON text block in response");
}

export class ClaudeClient implements ResearchClient {
  constructor(
    private http: HttpFn,
    private cfg: () => { apiKey: string; model: string; useWebSearch: boolean },
  ) {}

  private async call(content: unknown, maxTokens: number, research: boolean): Promise<{ text: string; sources: Source[] }> {
    const { apiKey, model, useWebSearch } = this.cfg();
    if (!apiKey) throw new Error("Anthropic API key is not set. Add it in the plugin settings.");
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    };
    if (research && useWebSearch) body.tools = [WEB_SEARCH];
    const res = await this.http({
      url: API_URL,
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      const msg = res.json?.error?.message;
      const raw = header(res.headers, "retry-after");
      const secs = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      throw new ApiError(
        typeof msg === "string" && msg ? msg : `HTTP ${res.status}`,
        res.status,
        Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined,
      );
    }
    if (res.json?.stop_reason === "max_tokens") throw new ParseError("Response truncated (max_tokens)");
    return { text: lastJsonText(res.json), sources: research && useWebSearch ? extractSources(res.json) : [] };
  }

  async outline(topic: string, parents: string[], max: number, context = ""): Promise<Outline> {
    return parseOutline((await this.call(outlinePrompt(topic, parents, max, context), 4096, true)).text, max);
  }

  async notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number, opts: NotesOptions = {}): Promise<NotesResult> {
    const { text, sources } = await this.call(notesPrompt(topic, parents, s, count, opts), 12288, true);
    const r = parseNotes(text, count, opts.subject, opts.codeLanguage);
    // Every note of the call shares the pages it found; with none, the notes stay without a Sources section.
    return sources.length > 0 ? { ...r, notes: r.notes.map((n) => ({ ...n, sources })) } : r;
  }

  async overviewPdf(pdfName: string, subfolders: string[], pdfBase64: string, pageOffset: number, context = ""): Promise<PdfOverview> {
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: pdfOverviewPrompt(pdfName, subfolders, pageOffset, context) },
    ];
    return parsePdfOverview((await this.call(content, 8192, false)).text, subfolders);
  }

  async mergeOverviews(pdfName: string, candidates: PdfOverview[]): Promise<PdfOverview> {
    // The candidates' subfolders were already matched to the existing names; only those may come back.
    const subfolders = [...new Set(candidates.flatMap((c) => c.keyPoints.flatMap((k) => (k.subfolder ? [k.subfolder] : []))))];
    return parsePdfOverview((await this.call(mergeOverviewsPrompt(pdfName, candidates), 4096, false)).text, subfolders);
  }
}
