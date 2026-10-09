export interface SubfolderSuggestion { name: string; why: string; }
export interface Outline { topic: string; summary: string; subfolders: SubfolderSuggestion[]; }
export interface NoteContent { title: string; summary: string; keyPoints: string[]; plainWords: string; }
export interface SubfolderNotes { subfolder: string; notes: NoteContent[]; }
export interface ExtractedNote extends NoteContent { subfolder: string; isNew: boolean; pages: string; }
export interface PdfExtraction { summary: string; notes: ExtractedNote[]; }
/** One idea from a PDF overview. `name` has at most 5 words; `text` is one sentence ending with `(p. N)`. */
export interface KeyPoint { name: string; text: string; detail: string; pages: string; subfolder?: string; }
/** Stage 1 result: 0..5 key points (never padded). */
export interface PdfOverview { summary: string; plainWords: string; keyPoints: KeyPoint[]; }
/** `summary` carries the reviewed outline's summary into the overview written by the approved job. */
export type Job =
  | { id: string; kind: "research"; path: string; approved?: SubfolderSuggestion[]; done: string[]; force?: boolean; summary?: string }
  /**
   * `triggeredAt`: ms epoch when the trigger queued it. `resume`: restored from data.json after a restart
   * (skipped only when its content finished processing at or after `triggeredAt`).
   */
  | { id: string; kind: "pdf"; path: string; resume?: boolean; triggeredAt?: number }
  /** Stage 2: research one key point. `path` is its entry note (unique); the notes go into `folder`. */
  | { id: string; kind: "keypoint"; path: string; folder: string; pdfName: string; topic: string; parents: string[]; point: KeyPoint };
export type Progress =
  | { kind: "step"; text: string }
  | { kind: "outline"; outline: Outline }
  | { kind: "writing"; index: number; total: number; name: string }
  | { kind: "itemDone"; name: string; ok: boolean; error?: string }
  | { kind: "done"; folders: number; notes: number }
  | { kind: "failed"; error: string };
/** Folder suggestions waiting for the user's review (persisted in data.json). */
export interface PendingReview { path: string; outline: Outline; }
