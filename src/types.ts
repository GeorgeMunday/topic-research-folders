import type { Extras, Subject } from "./subjects";

export interface SubfolderSuggestion { name: string; why: string; }
/** `subject` / `codeLanguage`: what kind of topic this is (saved in the Overview frontmatter); absent when the model gave none. */
export interface Outline { topic: string; summary: string; subfolders: SubfolderSuggestion[]; subject?: Subject; codeLanguage?: string; }
/** `extras`: the subject-specific section (code examples, formulas, ...), absent when missing or invalid. */
export interface NoteContent { title: string; summary: string; keyPoints: string[]; plainWords: string; extras?: Extras; }
/** Quiz questions with matching answers (equal length); `note` is the title of the note an answer comes from. */
export interface Quiz { questions: string[]; answers: { text: string; note?: string }[]; }
/** What one notes call returns: the notes and the quiz for their subfolder. */
export interface NotesResult { notes: NoteContent[]; quiz: Quiz; }
export interface SubfolderNotes { subfolder: string; notes: NoteContent[]; quiz?: Quiz; }
/** One idea from a PDF overview. `name` has at most 5 words; `text` is one sentence ending with `(p. N)`. */
export interface KeyPoint { name: string; text: string; detail: string; pages: string; subfolder?: string; }
/** Stage 1 result: 0..5 key points (never padded). */
export interface PdfOverview { summary: string; plainWords: string; keyPoints: KeyPoint[]; subject?: Subject; codeLanguage?: string; }
/** `summary` carries the reviewed outline's summary into the overview written by the approved job. */
export type Job =
  | { id: string; kind: "research"; path: string; approved?: SubfolderSuggestion[]; done: string[]; force?: boolean; summary?: string; subject?: Subject; codeLanguage?: string }
  /**
   * `triggeredAt`: ms epoch when the trigger queued it. `resume`: restored from data.json after a restart
   * (skipped only when its content finished processing at or after `triggeredAt`).
   */
  | { id: string; kind: "pdf"; path: string; resume?: boolean; triggeredAt?: number }
  /** Stage 2: research one key point. `path` is its entry note (unique); the notes go into `folder`. */
  | { id: string; kind: "keypoint"; path: string; folder: string; pdfName: string; topic: string; parents: string[]; point: KeyPoint; docSummary?: string; subject?: Subject; codeLanguage?: string };
export type Progress =
  | { kind: "step"; text: string }
  | { kind: "outline"; outline: Outline }
  | { kind: "writing"; index: number; total: number; name: string }
  | { kind: "itemDone"; name: string; ok: boolean; error?: string }
  | { kind: "done"; folders: number; notes: number }
  | { kind: "failed"; error: string };
/** Folder suggestions waiting for the user's review (persisted in data.json). */
export interface PendingReview { path: string; outline: Outline; }
