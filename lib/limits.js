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
/** Initial whole model-visible output budget; deployment config may replace it. */
export const DEFAULT_MAX_RENDERED_CONTENT_CHARS = 12_000;
/** Hard decoded network input limit, enforced while reading rather than after JSON parsing. */
export const MAX_RESPONSE_BYTES = 5_000_000;
/** Bounded metadata shared by native and advanced search adapters. */
export const MAX_SOURCE_TITLE_CHARS = 1_000;
export const MAX_SOURCE_SNIPPET_CHARS = 2_000;
export const MAX_SOURCE_URL_CHARS = 4_000;
export const MAX_SEARCH_RESULTS = 50;
/** Native search has no official renderer cap; constrain the provider projection itself. */
export const MAX_NATIVE_SEARCH_CHARS = 12_000;
/** Bound structured diagnostics as well as the final error message. */
export const MAX_DIAGNOSTIC_CHARS = 256;
