import { ANYSEARCH_DEFAULT_BASE_URL } from "./client.js";
import { defaultKeysPath, defaultStatePath } from "./keys.js";
import { DEFAULT_MAX_RENDERED_CONTENT_CHARS } from "./limits.js";

export function resolveConfig(config = {}) {
  const baseURL = (config.baseURL ?? ANYSEARCH_DEFAULT_BASE_URL).trim();
  let parsedURL;
  try {
    parsedURL = new URL(baseURL);
  } catch {
    throw new Error("baseURL must be an absolute URL");
  }
  if (parsedURL.protocol !== "https:") {
    throw new Error("baseURL must use HTTPS to protect API keys");
  }
  if (parsedURL.username.length > 0 || parsedURL.password.length > 0) {
    throw new Error("baseURL must not contain credentials");
  }
  const configuredKeysPath = (config.keysPath ?? "").trim();
  const keysPath = configuredKeysPath || defaultKeysPath();
  const configuredStatePath = (config.statePath ?? "").trim();
  const statePath = configuredStatePath || defaultStatePath(keysPath);
  const maxRenderedContentChars = config.maxRenderedContentChars ?? DEFAULT_MAX_RENDERED_CONTENT_CHARS;
  if (!Number.isSafeInteger(maxRenderedContentChars) || maxRenderedContentChars < 1) {
    throw new Error("maxRenderedContentChars must be a positive integer");
  }
  return {
    baseURL,
    keysPath,
    statePath,
    maxRenderedContentChars,
    advancedTools: config.advancedTools === true,
  };
}
