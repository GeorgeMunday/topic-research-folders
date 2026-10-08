import { test, expect } from "vitest";
import { extractJson, parseOutline, parseNotes, parsePdfExtraction, ParseError } from "../src/research/parse";

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
