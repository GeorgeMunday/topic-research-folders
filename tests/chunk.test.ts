import { beforeAll, describe, expect, test } from "vitest";
import { PDFDocument } from "pdf-lib";
import { PdfError, inspectPdf, planChunks, sha256, splitPdf } from "../src/pdf/chunk";

function b64ToBuf(b64: string): ArrayBuffer {
  const u = Uint8Array.from(Buffer.from(b64, "base64"));
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}
function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

let fixture120: ArrayBuffer;
let encrypted: ArrayBuffer;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 120; i++) doc.addPage().drawText(`page ${i + 1}`);
  fixture120 = toBuf(await doc.save());

  // pdf-lib cannot encrypt; add an /Encrypt entry to the trailer so load() rejects it.
  const enc = await PDFDocument.create();
  enc.addPage();
  enc.context.trailerInfo.Encrypt = enc.context.register(
    enc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 }),
  );
  encrypted = toBuf(await enc.save());
});

describe("planChunks", () => {
  test("respects page limit", () =>
    expect(planChunks(Array(120).fill(1000), 50, 1e9).ranges).toEqual([[0, 49], [50, 99], [100, 119]]));
  test("respects byte limit", () =>
    expect(planChunks([6, 6, 6, 6], 50, 12).ranges).toEqual([[0, 1], [2, 3]]));
  test("reports single oversized page", () =>
    expect(planChunks([5, 30, 5], 50, 12)).toEqual({ ranges: [[0, 0], [2, 2]], oversized: [1] }));
  test("empty input", () => expect(planChunks([], 50, 12)).toEqual({ ranges: [], oversized: [] }));
});

describe("splitPdf", () => {
  test("120-page fixture → 3 chunks with correct 1-based page numbers", async () => {
    const r = await splitPdf(fixture120, 50, 20_000_000);
    expect(r.chunks.map(c => [c.firstPage, c.lastPage])).toEqual([[1, 50], [51, 100], [101, 120]]);
    expect(r.skippedPages).toEqual([]);
    expect((await inspectPdf(b64ToBuf(r.chunks[1].base64))).pageCount).toBe(50);
  });
  test("small file → single chunk with all pages", async () => {
    const r = await splitPdf(fixture120, 200, 20_000_000);
    expect(r.chunks.map(c => [c.firstPage, c.lastPage])).toEqual([[1, 120]]);
    expect((await inspectPdf(b64ToBuf(r.chunks[0].base64))).pageCount).toBe(120);
  });
  test("byte limit splits and skips oversized pages (1-based)", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage();
    const r = await splitPdf(toBuf(await doc.save()), 50, 1);
    expect(r.chunks).toEqual([]);
    expect(r.skippedPages).toEqual([1, 2, 3]);
  });
});

describe("errors", () => {
  test("encrypted pdf → PdfError encrypted", async () => {
    await expect(inspectPdf(encrypted)).rejects.toMatchObject({ name: "PdfError", reason: "encrypted" });
    await expect(splitPdf(encrypted, 50, 1e6)).rejects.toBeInstanceOf(PdfError);
  });
  test("garbage bytes → PdfError unreadable", async () => {
    const garbage = new TextEncoder().encode("this is not a pdf at all").buffer as ArrayBuffer;
    await expect(inspectPdf(garbage)).rejects.toMatchObject({ reason: "unreadable" });
  });
});

test("sha256 is stable hex", async () =>
  expect(await sha256(new TextEncoder().encode("abc").buffer as ArrayBuffer))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));

describe("splitPdf real-size verification", () => {
  const noise = (n: number) => { let x = 12345, o = ""; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; o += String.fromCharCode(65 + (x >> 16) % 26); } return o; };
  async function build(sizes: number[]): Promise<ArrayBuffer> {
    const doc = await PDFDocument.create();
    sizes.forEach((n, i) => {
      const p = doc.addPage();
      p.drawText(`p${i}`);
      // large content stream (uncompressed) ~ n bytes
      if (n > 0) p.drawText(noise(n), { size: 1 });
    });
    return toBuf(await doc.save());
  }
  const coverage = (r: Awaited<ReturnType<typeof splitPdf>>) => {
    const pages: number[] = [];
    for (const c of r.chunks) for (let p = c.firstPage; p <= c.lastPage; p++) pages.push(p);
    return [...pages, ...r.skippedPages].sort((a, b) => a - b);
  };

  test("average-estimated chunks exceeding maxBytes are re-split", async () => {
    const sizes = [...Array(6).fill(0), ...Array(6).fill(5000)];
    const bytes = await build(sizes);
    const bigOnly = (await splitPdf(await build([5000]), 50, 1e9)).chunks[0];
    const maxBytes = Buffer.from(bigOnly.base64, "base64").length * 3;
    const r = await splitPdf(bytes, 50, maxBytes, { measureLimit: 0 });
    expect(r.skippedPages).toEqual([]);
    for (const c of r.chunks) expect(Buffer.from(c.base64, "base64").length).toBeLessThanOrEqual(maxBytes);
    expect(r.chunks.length).toBeGreaterThan(2);
    expect(coverage(r)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const starts = r.chunks.map(c => c.firstPage);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  test("oversized middle page is skipped; later chunks keep absolute numbers", async () => {
    const bytes = await build([0, 0, 30000, 0, 0, 0]);
    const r = await splitPdf(bytes, 50, 8000);
    expect(r.skippedPages).toEqual([3]);
    expect(r.chunks.map(c => [c.firstPage, c.lastPage])).toEqual([[1, 2], [4, 6]]);
    expect((await inspectPdf(b64ToBuf(r.chunks[1].base64))).pageCount).toBe(3);
  });
});
