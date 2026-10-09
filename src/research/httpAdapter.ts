import type { HttpFn } from "./claudeClient";

export interface RequestUrlParam { url: string; method: string; headers: Record<string, string>; body?: string; throw: boolean; }
export interface RequestUrlResult { status: number; json: any; headers: Record<string, string>; }
export type RequestUrlFn = (p: RequestUrlParam) => Promise<RequestUrlResult>;

/**
 * Adapts Obsidian's requestUrl to HttpFn. A transport failure (e.g. offline) rejects with a plain
 * Error; rethrow it as a TypeError so the queue treats it as a retryable network error.
 * Only the message is kept: never headers, body or key.
 */
export function makeHttp(requestUrl: RequestUrlFn): HttpFn {
  return async (req) => {
    let res: RequestUrlResult;
    try {
      res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
    } catch (e) {
      throw new TypeError(e instanceof Error ? e.message : "Network request failed");
    }
    let json: any;
    try { json = res.json; } catch { json = undefined; }
    return { status: res.status, json, headers: res.headers };
  };
}

export type GetFn = (req: { url: string; method: "GET"; headers: Record<string, string> })
  => Promise<{ status: number; json: any; headers: Record<string, string> }>;

/** GET counterpart of makeHttp: same TypeError-on-transport-failure rule, message only. */
export function makeGet(requestUrl: RequestUrlFn): GetFn {
  return async (req) => {
    let res: RequestUrlResult;
    try {
      res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, throw: false });
    } catch (e) {
      throw new TypeError(e instanceof Error ? e.message : "Network request failed");
    }
    let json: any;
    try { json = res.json; } catch { json = undefined; }
    return { status: res.status, json, headers: res.headers };
  };
}
