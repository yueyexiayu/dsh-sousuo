import { applyWebFetchTool, DEFAULT_FETCH_MAX_OUTPUT_CHARS, DEFAULT_WEB_TOOL_TIMEOUT_MS } from "@deepseek-ai/dsh-tool-web";
import z from "@deepseek-ai/schemastery";
import { ANYSEARCH_DEFAULT_BASE_URL, AnySearchClient } from "./client.js";
import { AnySearchFetchProvider } from "./fetch-provider.js";
import { KeyPool, defaultKeysPath } from "./keys.js";
import { AnySearchProvider } from "./provider.js";
import { registerBatchSearchTool } from "./tools/batch.js";
import { registerCapabilitiesTool } from "./tools/capabilities.js";
import { DEFAULT_MAX_RENDERED_CONTENT_CHARS, registerAdvancedSearchTool } from "./tools/search.js";

export const name = "sousuo";
export const inject = ["web", "systemPrompt", "tools"];

export const Config = z.object({
  baseURL: z.string(),
  maxRenderedContentChars: z.number().step(1).min(1).default(DEFAULT_MAX_RENDERED_CONTENT_CHARS),
});

export function resolveConfig(config = {}) {
  const baseURL = (config.baseURL ?? ANYSEARCH_DEFAULT_BASE_URL).trim();
  let parsedURL;
  try {
    parsedURL = new URL(baseURL);
  } catch {
    throw new Error("baseURL must be an absolute URL");
  }
  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw new Error("baseURL must use HTTP or HTTPS");
  }
  if (parsedURL.username.length > 0 || parsedURL.password.length > 0) {
    throw new Error("baseURL must not contain credentials");
  }
  const keysPath = (config.keysPath ?? defaultKeysPath()).trim();
  if (keysPath.length === 0) throw new Error("keysPath must be a non-empty path");
  const maxRenderedContentChars = config.maxRenderedContentChars ?? DEFAULT_MAX_RENDERED_CONTENT_CHARS;
  if (!Number.isSafeInteger(maxRenderedContentChars) || maxRenderedContentChars < 1) {
    throw new Error("maxRenderedContentChars must be a positive integer");
  }
  return { baseURL, keysPath, maxRenderedContentChars };
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const pool = new KeyPool({ keysPath: resolved.keysPath });
  const client = new AnySearchClient({
    pool,
    baseURL: resolved.baseURL,
  });
  ctx.web.registerSearchProvider(new AnySearchProvider(client));
  ctx.web.registerFetchProvider(new AnySearchFetchProvider(client));
  if (ctx.tools.get("web_fetch") === undefined) {
    applyWebFetchTool(ctx, DEFAULT_WEB_TOOL_TIMEOUT_MS, DEFAULT_FETCH_MAX_OUTPUT_CHARS);
  }
  registerCapabilitiesTool(ctx, client);
  registerBatchSearchTool(ctx, client, resolved.maxRenderedContentChars);
  registerAdvancedSearchTool(ctx, client, resolved.maxRenderedContentChars);
}
