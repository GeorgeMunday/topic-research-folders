import type { Outline, SubfolderSuggestion } from "../types";
import { sanitiseName, uniqueName } from "../names";

/** "Research: intro — Introduction to C#": the folder name, then what it was read as (when that differs). */
export function modalTitle(folderName: string, outline: Outline): string {
  const resolved = outline.resolvedTopic?.trim();
  return resolved && resolved !== folderName ? `Research: ${folderName} — ${resolved}` : `Research: ${folderName}`;
}

export interface SuggestionRow { suggestion: SubfolderSuggestion; name: string; checked: boolean; }

// Folders the plugin itself creates inside a research root.
const RESERVED = new Set(["sources", "from pdfs"]);

/**
 * Checked rows only, with edited names sanitised (blank edits fall back to the original).
 * Names are made unique case-insensitively (the flow tracks progress by name) and a name that
 * equals a reserved folder gets " notes" appended.
 */
export function selectApproved(rows: SuggestionRow[]): SubfolderSuggestion[] {
  const seen = new Set<string>();
  return rows
    .filter((r) => r.checked)
    .map((r) => {
      let name = sanitiseName(r.name.trim() === "" ? r.suggestion.name : r.name);
      if (RESERVED.has(name.toLowerCase())) name = `${name} notes`;
      name = uniqueName(name, (c) => seen.has(c.toLowerCase()));
      seen.add(name.toLowerCase());
      return { name, why: r.suggestion.why };
    });
}
