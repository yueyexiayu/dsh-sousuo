/** Prompt section that sits next to the official web_search guidance. */
export const SEARCH_FOLLOWTHROUGH_SECTION = [
  "Ordinary web questions use web_search and web_fetch. Those already go through the sousuo AnySearch backend with key rotation.",
  "Do not call anysearch_capabilities, anysearch_search, or anysearch_batch_search unless the user explicitly needs an AnySearch vertical tag.",
  "After a search or fetch tool returns, either write a user-visible answer in this step or emit the next tool call. Never end a step with only reasoning.",
].join(" ");

/** Appended to model-visible AnySearch tool output when advanced tools are enabled. */
export const SEARCH_FOLLOWTHROUGH_FOOTER =
  "After this result: write a user-visible answer now, or emit another tool call. Do not end the step with only reasoning.";

export function withSearchFollowthrough(text) {
  return `${text}\n\n${SEARCH_FOLLOWTHROUGH_FOOTER}`;
}

export function registerSearchFollowthrough(ctx) {
  ctx.systemPrompt.section({
    name: "sousuo:search-followthrough",
    order: ctx.systemPrompt.getSectionOrder("TOOL_WEB_SEARCH") + 5,
    interpolate: false,
    text: SEARCH_FOLLOWTHROUGH_SECTION,
  });
}
