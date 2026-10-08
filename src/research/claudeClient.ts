import type { Outline, NoteContent, PdfExtraction, SubfolderSuggestion } from "../types";
import { outlinePrompt, notesPrompt, pdfPrompt } from "./prompts";
import { parseOutline, parseNotes, parsePdfExtraction, ParseError } from "./parse";
import { ApiError } from "../jobs/queue";

export interface ResearchClient {
  outline(topic: string, parents: string[], max: number): Promise<Outline>;
  notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number): Promise<NoteContent[]>;
  extractPdf(topic: string, subfolders: string[], pdfBase64: string, pageOffset: number): Promise<PdfExtraction>;
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

  private async call(content: unknown, maxTokens: number, research: boolean): Promise<string> {
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
    return lastJsonText(res.json);
  }

  async outline(topic: string, parents: string[], max: number): Promise<Outline> {
    return parseOutline(await this.call(outlinePrompt(topic, parents, max), 4096, true), max);
  }

  async notes(topic: string, parents: string[], s: SubfolderSuggestion, count: number): Promise<NoteContent[]> {
    return parseNotes(await this.call(notesPrompt(topic, parents, s, count), 8192, true), count);
  }

  async extractPdf(topic: string, subfolders: string[], pdfBase64: string, pageOffset: number): Promise<PdfExtraction> {
    const content = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: pdfPrompt(topic, subfolders, pageOffset) },
    ];
    return parsePdfExtraction(await this.call(content, 16000, false), subfolders);
  }
}
