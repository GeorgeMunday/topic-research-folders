const MAX_LENGTH = 100;

export function sanitiseName(raw: string): string {
  let name = raw
    // "C#" would lose its "#" below (it breaks links); keep what it says.
    .replace(/(?<=[A-Za-z0-9])#(?=[\s)\]-]|$)/g, " sharp")
    .replace(/[\\/:]/g, " - ")
    .replace(/[*"<>|?#^[\]]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/( - )+/g, " - ")
    .replace(/ {2,}/g, " ")
    .replace(/^[ .-]+|[ .-]+$/g, "");
  if (name.length > MAX_LENGTH) {
    name = name.slice(0, MAX_LENGTH).replace(/[ .-]+$/g, "");
  }
  return name === "" ? "Untitled" : name;
}

const ORDER_PREFIX = /^(\d{2,}) - (.+)$/s;

/** A folder name with its learning-order number ("02 - Variables") sanitised: the number does not count against the length limit. */
export function sanitiseFolderName(raw: string): string {
  const m = ORDER_PREFIX.exec(raw.trim());
  return m ? `${m[1]} - ${sanitiseName(m[2])}` : sanitiseName(raw);
}

/** The folder name without its learning-order number ("02 - Variables" → "Variables"). */
export function stripOrder(name: string): string {
  const m = /^\d{2} - (.+)$/s.exec(name);
  return m ? m[1] : name;
}

export function uniqueName(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  let counter = 2;
  while (exists(`${base} (${counter})`)) counter++;
  return `${base} (${counter})`;
}
