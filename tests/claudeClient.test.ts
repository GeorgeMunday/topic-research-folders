import { test, expect } from "vitest";
import { ClaudeClient, type HttpFn } from "../src/research/claudeClient";
import { ApiError } from "../src/jobs/queue";
import { ParseError } from "../src/research/parse";

type Req = Parameters<HttpFn>[0];
const OUTLINE = JSON.stringify({ topic: "T", summary: "S", subfolders: [{ name: "A", why: "w" }] });
const NOTES = JSON.stringify({ notes: [{ title: "N", summary: "s", keyPoints: ["k"], plainWords: "p" }] });
const PDF = JSON.stringify({ summary: "s", notes: [{ subfolder: "A", isNew: false, title: "N", summary: "s", keyPoints: ["k (p. 1)"], plainWords: "p", pages: "1" }] });

function fake(json: any, status = 200, headers: Record<string, string> = {}) {
  const reqs: Req[] = [];
  const http: HttpFn = async req => { reqs.push(req); return { status, json, headers }; };
  return { http, reqs };
}
const ok = (text: string) => ({ content: [{ type: "text", text }] });
const cfg = (over: Partial<{ apiKey: string; model: string; useWebSearch: boolean }> = {}) =>
  () => ({ apiKey: "test-key-123", model: "test-model", useWebSearch: true, ...over });

test("research request: headers, model, web search", async () => {
  const { http, reqs } = fake(ok(OUTLINE));
  const out = await new ClaudeClient(http, cfg()).outline("T", [], 5);
  expect(out.subfolders[0].name).toBe("A");
  const r = reqs[0];
  expect(r.url).toBe("https://api.anthropic.com/v1/messages");
  expect(r.method).toBe("POST");
  expect(r.headers["x-api-key"]).toBe("test-key-123");
  expect(r.headers["anthropic-version"]).toBe("2023-06-01");
  expect(r.headers["content-type"]).toBe("application/json");
  const body = JSON.parse(r.body);
  expect(body.model).toBe("test-model");
  expect(body.max_tokens).toBe(4096);
  expect(body.messages[0].role).toBe("user");
  expect(body.tools[0]).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
});

test("notes uses 8192 tokens and web search", async () => {
  const { http, reqs } = fake(ok(NOTES));
  const n = await new ClaudeClient(http, cfg()).notes("T", [], { name: "A", why: "w" }, 3);
  expect(n[0].title).toBe("N");
  const body = JSON.parse(reqs[0].body);
  expect(body.max_tokens).toBe(8192);
  expect(body.tools).toHaveLength(1);
});

test("no tools when web search off", async () => {
  const { http, reqs } = fake(ok(OUTLINE));
  await new ClaudeClient(http, cfg({ useWebSearch: false })).outline("T", [], 5);
  expect(JSON.parse(reqs[0].body).tools).toBeUndefined();
});

test("pdf request: document block first, no web search", async () => {
  const { http, reqs } = fake(ok(PDF));
  const res = await new ClaudeClient(http, cfg()).extractPdf("T", ["A"], "QUJD", 0);
  expect(res.notes[0].subfolder).toBe("A");
  const body = JSON.parse(reqs[0].body);
  expect(body.max_tokens).toBe(16000);
  expect(body.messages[0].content[0]).toEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } });
  expect(body.messages[0].content[1].type).toBe("text");
  expect(body.tools).toBeUndefined();
});

test("uses the LAST text block containing a brace", async () => {
  const { http } = fake({ content: [
    { type: "text", text: "Let me search {for} stuff" },
    { type: "web_search_tool_result", content: [] },
    { type: "text", text: OUTLINE },
    { type: "text", text: "done, no braces" },
  ] });
  const out = await new ClaudeClient(http, cfg()).outline("T", [], 5);
  expect(out.topic).toBe("T");
});

test("no usable text block -> ParseError", async () => {
  const { http } = fake({ content: [{ type: "text", text: "nothing here" }] });
  await expect(new ClaudeClient(http, cfg()).outline("T", [], 5)).rejects.toBeInstanceOf(ParseError);
});

test("non-200 -> ApiError with status, API message and retry-after ms", async () => {
  const { http } = fake({ error: { message: "rate_limit_error" } }, 429, { "Retry-After": "12" });
  const err = await new ClaudeClient(http, cfg()).outline("T", [], 5).catch(e => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(429);
  expect(err.message).toBe("rate_limit_error");
  expect(err.retryAfterMs).toBe(12000);
});

test("non-200 without message falls back to HTTP status; key never leaks", async () => {
  const { http } = fake({}, 500);
  const err = await new ClaudeClient(http, cfg()).outline("T", [], 5).catch(e => e);
  expect(err.message).toBe("HTTP 500");
  expect(err.retryAfterMs).toBeUndefined();
  expect(err.message).not.toContain("test-key-123");
});

test("empty api key throws before any request", async () => {
  const { http, reqs } = fake(ok(OUTLINE));
  await expect(new ClaudeClient(http, cfg({ apiKey: "" })).outline("T", [], 5)).rejects.toThrow(/API key/);
  expect(reqs).toHaveLength(0);
});

test("reads current settings each call", async () => {
  const { http, reqs } = fake(ok(OUTLINE));
  let key = "test-key-1";
  const c = new ClaudeClient(http, () => ({ apiKey: key, model: "m", useWebSearch: false }));
  await c.outline("T", [], 5);
  key = "test-key-2";
  await c.outline("T", [], 5);
  expect(reqs[0].headers["x-api-key"]).toBe("test-key-1");
  expect(reqs[1].headers["x-api-key"]).toBe("test-key-2");
});
