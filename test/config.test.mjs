import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../lib/config.js";

test("advancedTools defaults to false", () => {
  const resolved = resolveConfig({ baseURL: "https://api.anysearch.com" });
  assert.equal(resolved.advancedTools, false);
});

test("advancedTools is opt-in", () => {
  const resolved = resolveConfig({
    baseURL: "https://api.anysearch.com",
    advancedTools: true,
  });
  assert.equal(resolved.advancedTools, true);
});

test("non-boolean advancedTools stays off", () => {
  const resolved = resolveConfig({
    baseURL: "https://api.anysearch.com",
    advancedTools: "true",
  });
  assert.equal(resolved.advancedTools, false);
});
