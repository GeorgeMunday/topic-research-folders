import type { Outline, SubfolderSuggestion } from "../types";
import { sanitiseName, uniqueName } from "../names";

const pad = (n: number, total: number) => String(n).padStart(Math.max(2, String(total).length), "0");

/** The muted line under the title: where the folder sits ("Inside: c# › intro"). */
export function insideLine(path: string): string {
  return `Inside: ${path.split("/").filter((p) => p !== "").join(" › ")}`;
}

/** "Research: intro — Introduction to C#": the folder name, then what it was read as (when that differs). */
export function modalTitle(folderName: string, outline: Outline): string {
  const resolved = outline.resolvedTopic?.trim();
  return resolved && resolved !== folderName ? `Research: ${folderName} — ${resolved}` : `Research: ${folderName}`;
}

export interface SuggestionRow { suggestion: SubfolderSuggestion; name: string; checked: boolean; }

// Folders the plugin itself creates inside a research root.
const RESERVED = new Set(["sources", "from pdfs"]);

export function setAllChecked(rows: SuggestionRow[], checked: boolean): void {
  for (const r of rows) r.checked = checked;
}

/** Appends an editable, checked row with no description; its empty name is ignored by `selectApproved`. */
export function addOwnRow(rows: SuggestionRow[]): SuggestionRow {
  const row: SuggestionRow = { suggestion: { name: "", why: "" }, name: "", checked: true };
  rows.push(row);
  return row;
}

/** A copy of `rows` with the row at `from` moved to `to`; an index outside the list changes nothing. */
export function moveRow<T>(rows: T[], from: number, to: number): T[] {
  const out = [...rows];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r);
  return out;
}

/** What a key press in the pop-up does. `target`: where focus is (Enter must not fire from a field or button). */
export function keyAction(key: string, target: "text" | "button" | "other"): "create" | "cancel" | null {
  if (key === "Escape") return "cancel";
  if (key === "Enter" && target === "other") return "create";
  return null;
}

/**
 * Checked rows only, in the order shown, with edited names sanitised (blank edits fall back to the original;
 * rows with no name at all are ignored). `number` prefixes "01 - ", "02 - " … in that order.
 * Names are made unique case-insensitively (the flow tracks progress by name) and a name that
 * equals a reserved folder gets " notes" appended.
 */
export function selectApproved(rows: SuggestionRow[], opts: { number?: boolean } = {}): SubfolderSuggestion[] {
  const seen = new Set<string>();
  const chosen = rows.filter((r) => r.checked && (r.name.trim() !== "" || r.suggestion.name.trim() !== ""));
  return chosen
    .map((r, i) => {
      let name = sanitiseName(r.name.trim() === "" ? r.suggestion.name : r.name);
      if (RESERVED.has(name.toLowerCase())) name = `${name} notes`;
      name = uniqueName(name, (c) => seen.has(c.toLowerCase()));
      seen.add(name.toLowerCase());
      // Numbered after sanitising, so the number never counts against the name length limit.
      if (opts.number) name = `${pad(i + 1, chosen.length)} - ${name}`;
      return { name, why: r.suggestion.why };
    });
}
