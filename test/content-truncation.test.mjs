import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { AnySearchClient } from "../lib/client.js";

// Only the tool-registration factory is stubbed; execute/render use the plugin's real code.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@deepseek-ai/dsh-tools") {
      return { url: "data:text/javascript,export const defineTool = tool => tool;", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { registerAdvancedSearchTool, formatAdvancedSearchOutput } = await import("../lib/tools/search.js");
const { executeBatchSearch, formatBatchSearchOutput } = await import("../lib/tools/batch.js");
hooks.deregister();

function clientFor(lengths) {
  return new AnySearchClient({
    pool: { snapshot: async () => [{ key: "fixture-key", index: 0, count: 1 }] },
    baseURL: "https://anysearch.test",
    transportHooks: {
      fetch: async () => new Response(JSON.stringify({
        code: 0, message: "ok",
        data: {
          results: lengths.map((length, i) => ({
            title: `Page ${i}`, url: `https://example.com/${i}`, content: "x".repeat(length),
          })),
          metadata: { total_results: lengths.length, search_time_ms: 1 },
        },
      })),
    },
  });
}

function advancedTool(client, budget) {
  let tool;
  registerAdvancedSearchTool({ tools: { register: value => { tool = value; } } }, client, budget);
  return tool;
}

test("client reports aggregate canonical clipping across pages", async () => {
  const result = await clientFor([150_000, 60_000]).search({ query: "fixture" });
  assert.deepEqual(result.results.map(item => item.content.length), [150_000, 50_000]);
  assert.equal(result.contentTruncated, true);
});

test("an exact canonical boundary is complete", async () => {
  const result = await clientFor([200_000]).search({ query: "fixture" });
  assert.equal(result.contentTruncated, false);
});

test("advanced search reports canonical clipping even with a larger render budget", async () => {
  const tool = advancedTool(clientFor([210_000]), 300_000);
  const result = await tool.execute({ query: "fixture", includeContent: true }, {});
  assert.equal(result.results[0].content.length, 200_000);
  assert.equal(result.renderedContentTruncated, true);
  assert.match(formatAdvancedSearchOutput(result, true, 300_000), /truncated/i);
});

test("advanced search ignores omitted content and detects rendering-only clipping", async () => {
  const tool = advancedTool(clientFor([210_000]), 12_000);
  const omitted = await tool.execute({ query: "fixture", includeContent: false }, {});
  assert.equal(omitted.renderedContentTruncated, false);
  assert.equal("content" in omitted.results[0], false);
  const small = await advancedTool(clientFor([13_000]), 12_000)
    .execute({ query: "fixture", includeContent: true }, {});
  assert.equal(small.renderedContentTruncated, true);
});

test("batch propagates canonical clipping from included content", async () => {
  const parsed = [{ request: { query: "fixture" }, includeContent: true }];
  const result = await executeBatchSearch(clientFor([210_000]), parsed, undefined, 300_000);
  assert.equal(result.renderedContentTruncated, true);
  assert.match(formatBatchSearchOutput({ items: [{ includeContent: true }] }, result, 300_000), /truncated/i);
});

test("batch ignores clipping of omitted content but detects aggregate rendering limits", async () => {
  const omitted = await executeBatchSearch(clientFor([210_000]), [
    { request: { query: "fixture" }, includeContent: false },
  ], undefined, 300_000);
  assert.equal(omitted.renderedContentTruncated, false);
  const result = await executeBatchSearch(clientFor([8_000]), [
    { request: { query: "first" }, includeContent: true },
    { request: { query: "second" }, includeContent: true },
  ], undefined, 12_000);
  assert.equal(result.renderedContentTruncated, true);
});
