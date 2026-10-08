import { EncryptedPDFError, PDFDocument } from "pdf-lib";

export class PdfError extends Error {
  reason: "encrypted" | "unreadable";
  constructor(reason: "encrypted" | "unreadable", message?: string) {
    super(message ?? `PDF is ${reason}`);
    this.name = "PdfError";
    this.reason = reason;
  }
}

/**
 * Greedy planner. Ranges are contiguous, 0-based, inclusive. A page larger than
 * maxBytes on its own goes to `oversized` and ends the current chunk so that
 * ranges never span it.
 */
export function planChunks(
  pageSizes: number[], maxPages: number, maxBytes: number,
): { ranges: [number, number][]; oversized: number[] } {
  const ranges: [number, number][] = [];
  const oversized: number[] = [];
  let start = -1;
  let count = 0;
  let bytes = 0;
  const flush = (end: number) => {
    if (start >= 0) ranges.push([start, end]);
    start = -1; count = 0; bytes = 0;
  };
  for (let i = 0; i < pageSizes.length; i++) {
    const size = pageSizes[i];
    if (size > maxBytes) {
      flush(i - 1);
      oversized.push(i);
      continue;
    }
    if (start >= 0 && (count + 1 > maxPages || bytes + size > maxBytes)) flush(i - 1);
    if (start < 0) start = i;
    count++;
    bytes += size;
  }
  flush(pageSizes.length - 1);
  return { ranges, oversized };
}

async function load(bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // instanceof can fail across pdf-lib's cjs/es builds, so also match the message.
    if (e instanceof EncryptedPDFError || /is encrypted/i.test(msg)) throw new PdfError("encrypted");
    throw new PdfError("unreadable", msg);
  }
}

export async function inspectPdf(bytes: ArrayBuffer): Promise<{ pageCount: number }> {
  const doc = await load(bytes);
  return { pageCount: doc.getPageCount() };
}

function toBase64(u8: Uint8Array): string {
  let bin = "";
  const SLICE = 0x8000; // 32 KB
  for (let i = 0; i < u8.length; i += SLICE) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + SLICE) as unknown as number[]);
  }
  return btoa(bin);
}

const PER_PAGE_MEASURE_LIMIT = 600;

/**
 * Splits a PDF into chunks within the page/byte limits. firstPage/lastPage are
 * 1-based. `skippedPages` are 1-based page numbers of pages that alone exceed
 * maxBytes (excluded from every chunk).
 */
export async function splitPdf(
  bytes: ArrayBuffer, maxPages: number, maxBytes: number,
): Promise<{ chunks: { base64: string; firstPage: number; lastPage: number }[]; skippedPages: number[] }> {
  const src = await load(bytes);
  const pageCount = src.getPageCount();
  const total = bytes.byteLength;

  if (pageCount > 0 && pageCount <= maxPages && total <= maxBytes) {
    return {
      chunks: [{ base64: toBase64(new Uint8Array(bytes)), firstPage: 1, lastPage: pageCount }],
      skippedPages: [],
    };
  }

  const sizes: number[] = [];
  if (pageCount <= PER_PAGE_MEASURE_LIMIT) {
    for (let i = 0; i < pageCount; i++) {
      const one = await PDFDocument.create();
      const [p] = await one.copyPages(src, [i]);
      one.addPage(p);
      sizes.push((await one.save()).byteLength);
    }
  } else {
    for (let i = 0; i < pageCount; i++) sizes.push(total / pageCount);
  }

  const { ranges, oversized } = planChunks(sizes, maxPages, maxBytes);
  const chunks: { base64: string; firstPage: number; lastPage: number }[] = [];
  for (const [s, e] of ranges) {
    const out = await PDFDocument.create();
    const idx = Array.from({ length: e - s + 1 }, (_, k) => s + k);
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    chunks.push({ base64: toBase64(await out.save()), firstPage: s + 1, lastPage: e + 1 });
  }
  return { chunks, skippedPages: oversized.map(i => i + 1) };
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
