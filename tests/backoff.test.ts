import { test, expect } from "vitest";
import { delayFor, isRetryable } from "../src/jobs/backoff";
import { ApiError } from "../src/jobs/queue";

test("delayFor: retry-after wins, else 2^n*2s with ±20% jitter", () => {
  expect(delayFor(1, 7000, () => 0.5)).toBe(7000);
  expect(delayFor(1, undefined, () => 0.5)).toBe(2000);
  expect(delayFor(3, undefined, () => 1)).toBe(9600);
  expect(delayFor(3, undefined, () => 0)).toBe(6400);
});

test("isRetryable", () => {
  expect(isRetryable(new ApiError("x", 429))).toBe(true);
  expect(isRetryable(new ApiError("x", 503))).toBe(true);
  expect(isRetryable(new ApiError("x", 529))).toBe(true);
  expect(isRetryable(new ApiError("x", 401))).toBe(false);
  expect(isRetryable(new TypeError("Failed to fetch"))).toBe(true);
  expect(isRetryable(new Error("boom"))).toBe(false);
});
