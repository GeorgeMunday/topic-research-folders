import { test, expect } from "vitest";
import { extractJson, parseOutline, parseNotes, parsePdfExtraction, parsePdfOverview, ParseError } from "../src/research/parse";

test("extracts fenced JSON", () => expect(extractJson('x\n```json\n{"a":1}\n```')).toEqual({ a: 1 }));
test("extracts balanced object from prose", () => expect(extractJson('Sure! {"a":{"b":"}"}} done')).toEqual({ a: { b: "}" } }));
test("truncated JSON throws", () => expect(() => extractJson('{"a": [1, 2')).toThrow(ParseError));
test("parseOutline caps and drops blanks", () => {
  const subs = [...Array(9)].map((_, i) => ({ name: `S${i}`, why: "w" })).concat({ name: " ", why: "w" });
  expect(parseOutline(JSON.stringify({ topic: "T", summary: "s", subfolders: subs }), 6).subfolders).toHaveLength(6);
});
test("parseOutline with zero subfolders throws", () =>
  expect(() => parseOutline('{"topic":"T","summary":"s","subfolders":[]}', 6)).toThrow(ParseError));
test("parseNotes rejects missing keyPoints", () =>
  expect(() => parseNotes('{"notes":[{"title":"x","summary":"s","plainWords":"p"}]}', 1)).toThrow(ParseError));
test("parsePdfExtraction marks unknown subfolder as new", () => {
  const r = parsePdfExtraction(JSON.stringify({ summary: "s", notes: [
    { subfolder: "anatomy", isNew: false, title: "A", summary: "s", keyPoints: ["k (p. 1)"], plainWords: "p", pages: "1" },
    { subfolder: "Jets", isNew: false, title: "B", summary: "s", keyPoints: ["k (p. 2)"], plainWords: "p", pages: "2" } ] }),
    ["Anatomy"]);
  expect(r.notes[0]).toMatchObject({ subfolder: "Anatomy", isNew: false }); // case-insensitive match
  expect(r.notes[1]).toMatchObject({ subfolder: "Jets", isNew: true });
});
test("parseOutline defaults missing why to empty and trims", () => {
  const r = parseOutline('{"topic":" T ","summary":"s","subfolders":[{"name":"  A  "}]}', 6);
  expect(r.topic).toBe("T");
  expect(r.subfolders).toEqual([{ name: "A", why: "" }]);
});
test("parseNotes returns at most count notes", () => {
  const n = (t: string) => ({ title: t, summary: "s", keyPoints: ["k"], plainWords: "p" });
  const r = parseNotes(JSON.stringify({ notes: [n("a"), n("b"), n("c")] }), 2);
  expect(r.map(x => x.title)).toEqual(["a", "b"]);
});
test("parseNotes with zero valid notes throws", () => {
  expect(() => parseNotes('{"notes":[]}', 3)).toThrow(ParseError);
  expect(() => parseNotes('{"notes":[{"title":" ","summary":"s","keyPoints":["k"],"plainWords":"p"}]}', 3)).toThrow(ParseError);
});
test("escaped quote inside a string", () => expect(extractJson('{"a":"x\\"}"}')).toEqual({ a: 'x"}' }));
test("backslash before closing quote", () => expect(extractJson('{"a":"x\\\\"} tail')).toEqual({ a: "x\\" }));
test("bad fenced block falls back to unfenced JSON", () =>
  expect(extractJson('```json\n{oops}\n```\nHere: {"a":1}')).toEqual({ a: 1 }));
test("skips brace prose before real JSON", () =>
  expect(extractJson('Use {like this} then {"a":2}')).toEqual({ a: 2 }));
test("fenced JSON preferred over earlier prose object", () =>
  expect(extractJson('Example {"x":0}\n```json\n{"a":1}\n```')).toEqual({ a: 1 }));

// --- PDF overview (item 10) ---
const kp = (i: number, extra: Record<string, unknown> = {}) =>
  ({ name: `Point ${i}`, text: `Idea number ${i} matters (p. ${i})`, detail: `The paper says ${i}.`, pages: `${i}`, ...extra });
const ov = (points: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: "A paper about things.", plainWords: "Simple words.", keyPoints: points, ...over });

test("parsePdfOverview: 5 points kept; 7 points capped to 5; 3 points stay 3 (no padding)", () => {
  const five = parsePdfOverview(ov([1, 2, 3, 4, 5].map((i) => kp(i))), []);
  expect(five.keyPoints.map((p) => p.name)).toEqual(["Point 1", "Point 2", "Point 3", "Point 4", "Point 5"]);
  expect(five).toMatchObject({ summary: "A paper about things.", plainWords: "Simple words." });
  expect(five.keyPoints[0]).toEqual({ name: "Point 1", text: "Idea number 1 matters (p. 1)", detail: "The paper says 1.", pages: "1" });
  const seven = parsePdfOverview(ov([1, 2, 3, 4, 5, 6, 7].map((i) => kp(i))), []);
  expect(seven.keyPoints.map((p) => p.name)).toEqual(["Point 1", "Point 2", "Point 3", "Point 4", "Point 5"]);
  expect(parsePdfOverview(ov([1, 2, 3].map((i) => kp(i))), []).keyPoints).toHaveLength(3);
});

test("parsePdfOverview: names trimmed to 5 words; points without name or text dropped; pages coerced to string", () => {
  const r = parsePdfOverview(ov([
    kp(1, { name: "  One two three four five six seven " }),
    kp(2, { name: " " }),
    kp(3, { text: "" }),
    kp(4, { pages: 12 }),
    "junk",
  ]), []);
  expect(r.keyPoints.map((p) => p.name)).toEqual(["One two three four five", "Point 4"]);
  expect(r.keyPoints[1].pages).toBe("12");
});

test("parsePdfOverview: subfolder matched case-insensitively to the canonical name, unknown dropped", () => {
  const r = parsePdfOverview(ov([kp(1, { subfolder: "anatomy" }), kp(2, { subfolder: "Jets" }), kp(3)]), ["Anatomy", "History"]);
  expect(r.keyPoints[0].subfolder).toBe("Anatomy");
  expect(r.keyPoints[1]).not.toHaveProperty("subfolder");
  expect(r.keyPoints[2]).not.toHaveProperty("subfolder");
});

test("parsePdfOverview: a thin document with a summary and no key points is fine", () => {
  const r = parsePdfOverview(ov([]), []);
  expect(r.keyPoints).toEqual([]);
  expect(r.summary).toBe("A paper about things.");
});

test("parsePdfOverview: ParseError for no JSON, missing keyPoints, or no key points and no summary", () => {
  expect(() => parsePdfOverview("nothing", [])).toThrow(ParseError);
  expect(() => parsePdfOverview('{"summary":"s"}', [])).toThrow(ParseError);
  expect(() => parsePdfOverview(ov([], { summary: " " }), [])).toThrow(ParseError);
  expect(() => parsePdfOverview(ov([kp(1, { name: "" })], { summary: "" }), [])).toThrow(ParseError);
});
