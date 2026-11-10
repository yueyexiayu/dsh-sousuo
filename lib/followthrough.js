const EXTERNAL_TOOL_FOLLOWTHROUGH =
  "After a search or fetch tool returns, either write a user-visible answer in this step or emit the next tool call. Never end a step with only reasoning.";

/** Stable text retained for callers that only need the common followthrough rule. */
export const SEARCH_FOLLOWTHROUGH_SECTION = EXTERNAL_TOOL_FOLLOWTHROUGH;

/** Appended to model-visible AnySearch tool output when advanced tools are enabled. */
export const SEARCH_FOLLOWTHROUGH_FOOTER =
  "After this result: write a user-visible answer now, or emit another tool call. Do not end the step with only reasoning.";

export function withSearchFollowthrough(text) {
  return `${text}\n\n${SEARCH_FOLLOWTHROUGH_FOOTER}`;
}

export function buildSearchFollowthroughSection({ webSearch, webFetch, firecrawl, advancedTools } = {}) {
  const parts = [];
  if (webSearch) {
    parts.push("Open-ended research, keyword queries, and gathering sources use web_search (sousuo / AnySearch).");
    if (firecrawl) parts.push("Do not use Firecrawl MCP for vague or exploratory search.");
  }
  if (firecrawl) {
    parts.push("When the user gives a specific URL or names a particular page or site to read, use Firecrawl MCP (`mcp__firecrawl__firecrawl_scrape`).");
    if (webFetch) parts.push("Do not use web_fetch for those pages.");
  } else if (webFetch) {
    parts.push("When the user gives a specific URL or names a particular page or site to read, use web_fetch.");
  }
  if (advancedTools) {
    parts.push("Do not call anysearch_capabilities, anysearch_search, or anysearch_batch_search unless the user explicitly needs an AnySearch vertical tag.");
  }
  if (webSearch || webFetch || firecrawl || advancedTools) parts.push(EXTERNAL_TOOL_FOLLOWTHROUGH);
  return parts.join(" ");
}

export function registerSearchFollowthrough(ctx) {
  ctx.systemPrompt.section({
    name: "sousuo:search-followthrough",
    order: ctx.systemPrompt.getSectionOrder("TOOL_WEB_SEARCH") + 5,
    interpolate: false,
    text: ({ scope, toolSet }) => {
      const has = name => ctx.tools.get(name, scope, toolSet) !== undefined;
      return buildSearchFollowthroughSection({
        webSearch: has("web_search"),
        webFetch: has("web_fetch"),
        firecrawl: has("mcp__firecrawl__firecrawl_scrape"),
        advancedTools: has("anysearch_capabilities") || has("anysearch_search") || has("anysearch_batch_search"),
      });
    },
  });
}
