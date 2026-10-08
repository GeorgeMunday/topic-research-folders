const MAX_LENGTH = 100;

export function sanitiseName(raw: string): string {
  let name = raw
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

export function uniqueName(base: string, exists: (candidate: string) => boolean): string {
  if (!exists(base)) return base;
  let counter = 2;
  while (exists(`${base} (${counter})`)) counter++;
  return `${base} (${counter})`;
}
