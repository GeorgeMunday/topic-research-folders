import { pdfTriggerName } from "./pdf/trigger";

export type RenameDecision =
  | { action: "ignore" }
  | { action: "folder-event"; path: string }
  | { action: "pdf-event"; path: string };

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Obsidian fires one rename per descendant when a folder is renamed or moved, so most renames
 * must not start work: only an item whose own name changed can be a trigger. A file counts only
 * when its new name is a PDF trigger name (`paper+.pdf`, `paper.pdf+`); the plugin's own rename
 * back to `paper.pdf` therefore does nothing.
 */
export function decideRename(a: { isFolder: boolean; oldPath: string; newPath: string; suffix: string }): RenameDecision {
  const renamed = baseName(a.oldPath) !== baseName(a.newPath);
  if (a.isFolder) return renamed ? { action: "folder-event", path: a.newPath } : { action: "ignore" };
  if (!renamed || !pdfTriggerName(baseName(a.newPath), a.suffix)) return { action: "ignore" };
  return { action: "pdf-event", path: a.newPath };
}
