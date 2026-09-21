/** Cooperative deadline advertised by every AnySearch-specific tool. */
export const ANYSEARCH_TOOL_TIMEOUT_MS = 60_000;
/** HTTP deadline kept below the tool budget so failures can settle cleanly. */
export const ANYSEARCH_HTTP_TIMEOUT_MS = 55_000;
/** Extra system-DNS fetch after a transport failure, before public DNS fallback. */
export const NETWORK_RETRY_EXTRA_ATTEMPTS = 1;
/** Delay before the extra system-DNS fetch. */
export const NETWORK_RETRY_DELAY_MS = 200;
/** Per DoH lookup deadline so fallback cannot consume the search budget. */
export const NETWORK_DOH_TIMEOUT_MS = 2_500;
/** Maximum cleaned page content retained in one canonical search response. */
export const MAX_CANONICAL_CONTENT_CHARS = 200_000;
/** Maximum upstream-controlled error detail retained in one failure message. */
export const MAX_UPSTREAM_ERROR_CHARS = 2_000;
/** Initial model-visible content budget; deployment config may replace it. */
export const DEFAULT_MAX_RENDERED_CONTENT_CHARS = 12_000;
