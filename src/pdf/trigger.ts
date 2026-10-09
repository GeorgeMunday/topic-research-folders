// Pure: decides whether a file name asks for PDF analysis. No `obsidian` import.
import { isTriggerName, topicFromName } from "../trigger";

const PDF_EXT = /^(.*)(\.pdf)$/i;

/**
 * A PDF is analysed only when its name carries the trigger suffix, either before the extension
 * (`paper+.pdf`, the main form) or after it (`paper.pdf+`). `.pdf` is matched case-insensitively and
 * kept as written in `clean`. A name with nothing but the suffix (`+.pdf`, `.pdf+`) is not a trigger.
 * Called for every file event, so it does string work only.
 */
export function pdfTriggerName(fileName: string, suffix: string): { clean: string } | null {
  if (!suffix) return null;
  // paper+.pdf
  const m = PDF_EXT.exec(fileName);
  if (m && isTriggerName(m[1], suffix)) return { clean: topicFromName(m[1], suffix) + m[2] };
  // paper.pdf+
  if (isTriggerName(fileName, suffix)) {
    const rest = PDF_EXT.exec(topicFromName(fileName, suffix));
    if (rest && rest[1].trim() !== "") return { clean: rest[1].trim() + rest[2] };
  }
  return null;
}
