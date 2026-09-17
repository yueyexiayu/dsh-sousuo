import { ANYSEARCH_DEFAULT_BASE_URL } from "./client.js";
import { defaultKeysPath } from "./keys.js";
import { DEFAULT_MAX_RENDERED_CONTENT_CHARS } from "./limits.js";

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
  return {
    baseURL,
    keysPath,
    maxRenderedContentChars,
    advancedTools: config.advancedTools === true,
  };
}
