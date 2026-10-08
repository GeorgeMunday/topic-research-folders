export type RenameDecision =
  | { action: "ignore" }
  | { action: "folder-event"; path: string }
  | { action: "update-processed"; hash: string; path: string }
  | { action: "pdf-event"; path: string };

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const isPdf = (p: string) => /\.pdf$/i.test(p);

/**
 * Obsidian fires one rename per descendant when a folder is renamed or moved, so most renames
 * must not start work: only a folder whose own name changed can be a trigger, and a known,
 * already-processed PDF just needs its recorded path updated.
 */
export function decideRename(a: {
  isFolder: boolean;
  oldPath: string;
  newPath: string;
  processed: Record<string, { path: string; date: string }>;
}): RenameDecision {
  if (a.isFolder) {
    return baseName(a.oldPath) !== baseName(a.newPath) ? { action: "folder-event", path: a.newPath } : { action: "ignore" };
  }
  if (!isPdf(a.newPath)) return { action: "ignore" };
  for (const [hash, e] of Object.entries(a.processed)) {
    if (e.path === a.oldPath) return { action: "update-processed", hash, path: a.newPath };
  }
  return { action: "pdf-event", path: a.newPath };
}
