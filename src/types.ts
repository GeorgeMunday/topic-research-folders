export interface SubfolderSuggestion { name: string; why: string; }
export interface Outline { topic: string; summary: string; subfolders: SubfolderSuggestion[]; }
export interface NoteContent { title: string; summary: string; keyPoints: string[]; plainWords: string; }
export interface SubfolderNotes { subfolder: string; notes: NoteContent[]; }
export interface ExtractedNote extends NoteContent { subfolder: string; isNew: boolean; pages: string; }
export interface PdfExtraction { summary: string; notes: ExtractedNote[]; }
/** `summary` carries the reviewed outline's summary into the overview written by the approved job. */
export type Job =
  | { id: string; kind: "research"; path: string; approved?: SubfolderSuggestion[]; done: string[]; force?: boolean; summary?: string }
  /** `resume`: restored from data.json after a restart (skipped when its content was already processed). */
  | { id: string; kind: "pdf"; path: string; resume?: boolean };
export type Progress =
  | { kind: "step"; text: string }
  | { kind: "outline"; outline: Outline }
  | { kind: "writing"; index: number; total: number; name: string }
  | { kind: "itemDone"; name: string; ok: boolean; error?: string }
  | { kind: "done"; folders: number; notes: number }
  | { kind: "failed"; error: string };
/** Folder suggestions waiting for the user's review (persisted in data.json). */
export interface PendingReview { path: string; outline: Outline; }
