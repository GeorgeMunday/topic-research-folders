import type { Outline, NoteContent, PdfExtraction, ExtractedNote, SubfolderSuggestion } from "../types";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
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

export function extractJson(text: string): unknown {
  let candidate: string | null = null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidate = fence[1].trim();
  if (candidate === null || !candidate.startsWith("{")) candidate = balancedObject(candidate ?? text) ?? balancedObject(text);
  if (candidate === null) throw new ParseError("No JSON object found in response");
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new ParseError(`Invalid JSON: ${(e as Error).message}`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseNote(v: unknown): NoteContent | null {
  if (!isObj(v)) return null;
  const title = str(v.title);
  if (!title) return null;
  if (!Array.isArray(v.keyPoints)) throw new ParseError(`Note "${title}" is missing keyPoints`);
  const keyPoints = v.keyPoints.filter((k): k is string => typeof k === "string" && k.trim() !== "").map(k => k.trim());
  if (keyPoints.length === 0) throw new ParseError(`Note "${title}" has no key points`);
  return { title, summary: str(v.summary), keyPoints, plainWords: str(v.plainWords) };
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
  return { topic: str(data.topic), summary: str(data.summary), subfolders: subfolders.slice(0, max) };
}

export function parseNotes(text: string, count: number): NoteContent[] {
  const data = extractJson(text);
  if (!isObj(data) || !Array.isArray(data.notes)) throw new ParseError("Response is missing notes");
  const notes: NoteContent[] = [];
  for (const n of data.notes) {
    const note = parseNote(n);
    if (note) notes.push(note);
  }
  if (notes.length === 0) throw new ParseError("Response has no valid notes");
  return notes.slice(0, count);
}

export function parsePdfExtraction(text: string, subfolders: string[]): PdfExtraction {
  const data = extractJson(text);
  if (!isObj(data) || !Array.isArray(data.notes)) throw new ParseError("Extraction is missing notes");
  const notes: ExtractedNote[] = [];
  for (const n of data.notes) {
    const note = parseNote(n);
    if (!note || !isObj(n)) continue;
    const sub = str(n.subfolder);
    if (!sub) throw new ParseError(`Note "${note.title}" is missing subfolder`);
    const match = subfolders.find(s => s.toLowerCase() === sub.toLowerCase());
    notes.push({ ...note, subfolder: match ?? sub, isNew: !match, pages: str(n.pages) });
  }
  if (notes.length === 0) throw new ParseError("Extraction has no valid notes");
  return { summary: str(data.summary), notes };
}
