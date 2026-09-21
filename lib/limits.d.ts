/** Cooperative deadline advertised by every AnySearch-specific tool. */
export declare const ANYSEARCH_TOOL_TIMEOUT_MS = 60000;
/** HTTP deadline kept below the tool budget so failures can settle cleanly. */
export declare const ANYSEARCH_HTTP_TIMEOUT_MS = 55000;
/** Extra system-DNS fetch after a transport failure, before public DNS fallback. */
export declare const NETWORK_RETRY_EXTRA_ATTEMPTS = 1;
/** Delay before the extra system-DNS fetch. */
export declare const NETWORK_RETRY_DELAY_MS = 200;
/** Per DoH lookup deadline so fallback cannot consume the search budget. */
export declare const NETWORK_DOH_TIMEOUT_MS = 2500;
/** Maximum cleaned page content retained in one canonical search response. */
export declare const MAX_CANONICAL_CONTENT_CHARS = 200000;
/** Maximum upstream-controlled error detail retained in one failure message. */
export declare const MAX_UPSTREAM_ERROR_CHARS = 2000;
