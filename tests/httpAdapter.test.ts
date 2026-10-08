import { describe, expect, test } from "vitest";
import { makeHttp } from "../src/research/httpAdapter";
import { isRetryable } from "../src/jobs/backoff";

const req = { url: "https://x/y", method: "POST" as const, headers: { "x-api-key": "sk-secret" }, body: '{"secret":"body"}' };

describe("makeHttp", () => {
  test("offline rejection (plain Error) becomes a retryable TypeError with message only", async () => {
    const http = makeHttp((async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); }) as any);
    const err = await http(req).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isRetryable(err)).toBe(true);
    expect(err.message).toBe("net::ERR_INTERNET_DISCONNECTED");
    expect(JSON.stringify(err.message)).not.toContain("sk-secret");
    expect(err.cause).toBeUndefined();
  });

  test("non-Error rejection still yields a TypeError", async () => {
    const http = makeHttp((async () => { throw "boom"; }) as any);
    const err = await http(req).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  test("success maps status, json and headers, and passes throw:false", async () => {
    let seen: any;
    const http = makeHttp((async (o: any) => { seen = o; return { status: 200, json: { a: 1 }, headers: { h: "v" } }; }) as any);
    expect(await http(req)).toEqual({ status: 200, json: { a: 1 }, headers: { h: "v" } });
    expect(seen).toMatchObject({ url: req.url, method: "POST", headers: req.headers, body: req.body, throw: false });
  });

  test("non-JSON body (json getter throws) yields json undefined", async () => {
    const http = makeHttp((async () => ({ status: 502, get json() { throw new SyntaxError("bad json"); }, headers: {} })) as any);
    expect(await http(req)).toEqual({ status: 502, json: undefined, headers: {} });
  });
});
