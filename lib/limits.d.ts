/** Cooperative deadline advertised by every AnySearch-specific tool. */
export declare const ANYSEARCH_TOOL_TIMEOUT_MS = 60000;
/** HTTP deadline kept below the tool budget so failures can settle cleanly. */
export declare const ANYSEARCH_HTTP_TIMEOUT_MS = 55000;
export declare const NETWORK_RETRY_EXTRA_ATTEMPTS = 1;
export declare const NETWORK_RETRY_DELAY_MS = 200;
export declare const NETWORK_DOH_TIMEOUT_MS = 2500;
export declare const MAX_CANONICAL_CONTENT_CHARS = 200000;
export declare const MAX_UPSTREAM_ERROR_CHARS = 2000;
export declare const DEFAULT_MAX_RENDERED_CONTENT_CHARS = 12000;
export declare const MAX_RESPONSE_BYTES = 5000000;
export declare const MAX_SOURCE_TITLE_CHARS = 1000;
export declare const MAX_SOURCE_SNIPPET_CHARS = 2000;
export declare const MAX_SOURCE_URL_CHARS = 4000;
export declare const MAX_SEARCH_RESULTS = 50;
export declare const MAX_NATIVE_SEARCH_CHARS = 12000;
export declare const MAX_DIAGNOSTIC_CHARS = 256;
