import z from "@deepseek-ai/schemastery";
import { AnySearchClient } from "./client.js";
import { resolveConfig } from "./config.js";
import { AnySearchFetchProvider } from "./fetch-provider.js";
import { registerSearchFollowthrough } from "./followthrough.js";
import { KeyPool } from "./keys.js";
import { DEFAULT_MAX_RENDERED_CONTENT_CHARS } from "./limits.js";
import { AnySearchProvider } from "./provider.js";
import { registerBatchSearchTool } from "./tools/batch.js";
import { registerCapabilitiesTool } from "./tools/capabilities.js";
import { registerAdvancedSearchTool } from "./tools/search.js";

export { resolveConfig } from "./config.js";
export { SEARCH_FOLLOWTHROUGH_FOOTER, SEARCH_FOLLOWTHROUGH_SECTION } from "./followthrough.js";

export const Config = z.object({
  baseURL: z.string(),
  maxRenderedContentChars: z.number().step(1).min(1).default(DEFAULT_MAX_RENDERED_CONTENT_CHARS),
  advancedTools: z.boolean().default(false),
});

export const name = "sousuo";
export const inject = ["web", "systemPrompt", "tools"];

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const pool = new KeyPool({ keysPath: resolved.keysPath });
  const client = new AnySearchClient({
    pool,
    baseURL: resolved.baseURL,
  });
  ctx.web.registerSearchProvider(new AnySearchProvider(client));
  ctx.web.registerFetchProvider(new AnySearchFetchProvider(client));
  registerSearchFollowthrough(ctx);
  if (!resolved.advancedTools) return;
  registerCapabilitiesTool(ctx, client, resolved.maxRenderedContentChars);
  registerBatchSearchTool(ctx, client, resolved.maxRenderedContentChars);
  registerAdvancedSearchTool(ctx, client, resolved.maxRenderedContentChars);
}
