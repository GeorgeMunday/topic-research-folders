import type { SubfolderSuggestion } from "../types";
import { sanitiseName } from "../names";

export interface SuggestionRow { suggestion: SubfolderSuggestion; name: string; checked: boolean; }

/** Checked rows only, with edited names sanitised (blank edits fall back to the original). */
export function selectApproved(rows: SuggestionRow[]): SubfolderSuggestion[] {
  return rows
    .filter((r) => r.checked)
    .map((r) => ({
      name: sanitiseName(r.name.trim() === "" ? r.suggestion.name : r.name),
      why: r.suggestion.why,
    }));
}
