import { test, expect } from "vitest";
import { isTriggerName, topicFromName, strippedPath } from "../src/trigger";

test("detects suffix", () => {
  expect(isTriggerName("Black holes+", "+")).toBe(true);
  expect(isTriggerName("Black holes", "+")).toBe(false);
  expect(isTriggerName("+", "+")).toBe(false);
  expect(isTriggerName("Notes  +  ", "+")).toBe(true);
});
test("topic strips one suffix", () => {
  expect(topicFromName("Black holes+", "+")).toBe("Black holes");
  expect(topicFromName("C++", "+")).toBe("C+");
});
test("strippedPath keeps parent", () => {
  expect(strippedPath("Science/Black holes+", "+")).toBe("Science/Black holes");
});
