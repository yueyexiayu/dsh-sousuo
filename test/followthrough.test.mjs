import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchFollowthroughSection,
  registerSearchFollowthrough,
  SEARCH_FOLLOWTHROUGH_FOOTER,
  SEARCH_FOLLOWTHROUGH_SECTION,
  withSearchFollowthrough,
} from "../lib/followthrough.js";

test("followthrough describes only tools available in the current tool set", () => {
  const all = buildSearchFollowthroughSection({ webSearch: true, webFetch: true, firecrawl: true, advancedTools: true });
  assert.match(all, /web_search/);
  assert.match(all, /mcp__firecrawl__firecrawl_scrape/);
  assert.match(all, /Do not use web_fetch/);
  assert.match(all, /anysearch_capabilities/);
  assert.match(all, /only reasoning/);

  const fetchOnly = buildSearchFollowthroughSection({ webFetch: true });
  assert.match(fetchOnly, /use web_fetch/);
  assert.doesNotMatch(fetchOnly, /web_search|Firecrawl|anysearch_/);
  assert.equal(buildSearchFollowthroughSection(), "");
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /only reasoning/);
});

test("registered prompt section resolves availability for each tool scope", () => {
  let section;
  const tools = new Set(["web_search", "mcp__firecrawl__firecrawl_scrape"]);
  registerSearchFollowthrough({
    tools: { get: name => tools.has(name) ? {} : undefined },
    systemPrompt: { section: value => { section = value; }, getSectionOrder: () => 10 },
  });
  const text = section.text({ scope: {}, toolSet: new Set() });
  assert.match(text, /web_search/);
  assert.match(text, /mcp__firecrawl__firecrawl_scrape/);
  assert.doesNotMatch(text, /anysearch_capabilities|use web_fetch/);
});

test("withSearchFollowthrough appends the footer once", () => {
  const text = withSearchFollowthrough("Sources: example");
  assert.equal(text.endsWith(SEARCH_FOLLOWTHROUGH_FOOTER), true);
  assert.match(text, /^Sources: example\n\n/);
});
