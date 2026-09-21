import test from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_FOLLOWTHROUGH_FOOTER,
  SEARCH_FOLLOWTHROUGH_SECTION,
  withSearchFollowthrough,
} from "../lib/followthrough.js";

test("followthrough section routes vague search to sousuo and explicit URLs to Firecrawl", () => {
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /web_search/);
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /mcp__firecrawl__firecrawl_scrape/);
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /Do not use web_fetch/);
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /only reasoning/);
  assert.match(SEARCH_FOLLOWTHROUGH_SECTION, /Do not call anysearch_capabilities/);
});

test("withSearchFollowthrough appends the footer once", () => {
  const text = withSearchFollowthrough("Sources: example");
  assert.equal(text.endsWith(SEARCH_FOLLOWTHROUGH_FOOTER), true);
  assert.match(text, /^Sources: example\n\n/);
});
