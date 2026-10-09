import type { Outline, NoteContent, SubfolderSuggestion, KeyPoint, PdfOverview } from "../types";
import { normaliseLanguage, parseExtras, toSubject } from "../subjects";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

function balancedAt(text: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function scanParse(text: string): { ok: true; value: unknown } | { ok: false; err: string } {
  let err = "No JSON object found in response";
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const cand = balancedAt(text, i);
    if (cand === null) continue;
    try {
      return { ok: true, value: JSON.parse(cand) };
    } catch (e) {
      err = `Invalid JSON: ${(e as Error).message}`;
    }
  }
  return { ok: false, err };
}

export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const r = scanParse(fence[1]);
    if (r.ok) return r.value;
  }
  const r = scanParse(text);
  if (r.ok) return r.value;
  throw new ParseError(r.err);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseNote(v: unknown, subject: string, codeLanguage?: string): NoteContent | null {
  if (!isObj(v)) return null;
  const title = str(v.title);
  if (!title) return null;
  if (!Array.isArray(v.keyPoints)) throw new ParseError(`Note "${title}" is missing keyPoints`);
  const keyPoints = v.keyPoints.filter((k): k is string => typeof k === "string" && k.trim() !== "").map(k => k.trim());
  if (keyPoints.length === 0) throw new ParseError(`Note "${title}" has no key points`);
  const note: NoteContent = { title, summary: str(v.summary), keyPoints, plainWords: str(v.plainWords) };
  const extras = parseExtras(subject, v.extras, codeLanguage);
  if (extras) note.extras = extras;
  return note;
}

/** The subject and (coding only) language the model named; either may be absent. */
function parseSubject(data: Record<string, unknown>): { subject?: ReturnType<typeof toSubject>; codeLanguage?: string } {
  const subject = toSubject(data.subject);
  const codeLanguage = subject === "coding" ? normaliseLanguage(data.codeLanguage) : undefined;
  return { ...(subject ? { subject } : {}), ...(codeLanguage ? { codeLanguage } : {}) };
}

export function parseOutline(text: string, max: number): Outline {
  const data = extractJson(text);
  if (!isObj(data) || !Array.isArray(data.subfolders)) throw new ParseError("Outline is missing subfolders");
  const subfolders: SubfolderSuggestion[] = [];
  for (const s of data.subfolders) {
    if (!isObj(s)) continue;
    const name = str(s.name);
    if (name) subfolders.push({ name, why: str(s.why) });
  }
  if (subfolders.length === 0) throw new ParseError("Outline has no valid subfolders");
  return { topic: str(data.topic), summary: str(data.summary), subfolders: subfolders.slice(0, max), ...parseSubject(data) };
}

export function parseNotes(text: string, count: number, subject = "general", codeLanguage?: string): NoteContent[] {
  const data = extractJson(text);
  if (!isObj(data) || !Array.isArray(data.notes)) throw new ParseError("Response is missing notes");
  const notes: NoteContent[] = [];
  for (const n of data.notes) {
    const note = parseNote(n, subject, codeLanguage);
    if (note) notes.push(note);
  }
  if (notes.length === 0) throw new ParseError("Response has no valid notes");
  return notes.slice(0, count);
}

const MAX_KEY_POINTS = 5;
const MAX_NAME_WORDS = 5;

export function parsePdfOverview(text: string, subfolders: string[]): PdfOverview {
  const data = extractJson(text);
  if (!isObj(data) || !Array.isArray(data.keyPoints)) throw new ParseError("Overview is missing keyPoints");
  const canonical = new Map(subfolders.map((s) => [s.toLowerCase(), s]));
  const keyPoints: KeyPoint[] = [];
  for (const k of data.keyPoints) {
    if (!isObj(k)) continue;
    const name = str(k.name).split(/\s+/).filter((w) => w !== "").slice(0, MAX_NAME_WORDS).join(" ");
    let pointText = str(k.text);
    if (!name || !pointText) continue;
    const pages = typeof k.pages === "number" && Number.isFinite(k.pages) ? String(k.pages) : str(k.pages);
    // Every key point ends with its page reference; add it from `pages` when the model left it out.
    const first = /\d+/.exec(pages);
    if (!/\(pp?\.\s*[^)]*\)\s*\.?$/i.test(pointText) && first) pointText = `${pointText} (p. ${first[0]})`;
    const point: KeyPoint = { name, text: pointText, detail: str(k.detail), pages };
    const sub = canonical.get(str(k.subfolder).toLowerCase());
    if (sub !== undefined && str(k.subfolder) !== "") point.subfolder = sub;
    keyPoints.push(point);
    if (keyPoints.length === MAX_KEY_POINTS) break;
  }
  const summary = str(data.summary);
  // A thin document may genuinely have no distinct key points, but then it must at least be summarised.
  if (keyPoints.length === 0 && !summary) throw new ParseError("Overview has no key points and no summary");
  return { summary, plainWords: str(data.plainWords), keyPoints, ...parseSubject(data) };
}
