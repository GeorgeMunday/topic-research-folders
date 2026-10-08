export function isTriggerName(name: string, suffix: string): boolean {
  if (!suffix) return false;
  const t = name.trim();
  return t.endsWith(suffix) && t.slice(0, -suffix.length).trim().length > 0;
}

export function topicFromName(name: string, suffix: string): string {
  const t = name.trim();
  return t.endsWith(suffix) ? t.slice(0, -suffix.length).trim() : t;
}

export function strippedPath(path: string, suffix: string): string {
  const i = path.lastIndexOf("/");
  const parent = i >= 0 ? path.slice(0, i + 1) : "";
  return parent + topicFromName(path.slice(i + 1), suffix);
}
