// Pure: the pages a web search really returned (never URLs the model wrote in its text). No `obsidian` import.

export interface Source { title: string; url: string }

export const MAX_SOURCES = 5;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A link-safe http(s) URL without its fragment, or null. */
function cleanUrl(raw: unknown): { url: string; host: string; key: string } | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const url = raw.trim().split("#")[0].replace(/\s/g, "%20").replace(/\)/g, "%29");
  const key = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  return { url, host: u.hostname, key };
}

function cleanTitle(raw: unknown, host: string): string {
  const t = typeof raw === "string" ? raw.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() : "";
  return t === "" ? host : t;
}

/**
 * The sources of one Messages API response: the pages the text blocks cite, else the pages the web search
 * returned. Deduplicated by URL, at most MAX_SOURCES, in the order given.
 */
export function extractSources(json: unknown): Source[] {
  const blocks: unknown[] = isObj(json) && Array.isArray(json.content) ? json.content : [];
  const cited: unknown[] = [];
  const found: unknown[] = [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    if (b.type === "text" && Array.isArray(b.citations)) cited.push(...b.citations);
    else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) found.push(...b.content);
  }
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const c of cited.length > 0 ? cited : found) {
    if (!isObj(c)) continue;
    const u = cleanUrl(c.url);
    if (!u || seen.has(u.key)) continue;
    seen.add(u.key);
    out.push({ title: cleanTitle(c.title, u.host), url: u.url });
    if (out.length === MAX_SOURCES) break;
  }
  return out;
}

/** " (p. 3–5)" for "3-5", " (p. 7)" for "7"; "" when there are no pages. */
export function pageLabel(pages: string | undefined): string {
  const p = (pages ?? "").trim();
  return p === "" ? "" : ` (p. ${p.replace(/\s*-\s*/g, "–")})`;
}
