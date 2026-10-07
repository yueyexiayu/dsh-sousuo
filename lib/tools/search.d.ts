/** Model-facing AnySearch search tool with dynamic vertical parameters. */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-tools';
import type { AnySearchClient } from '../client.js';
import type { AnySearchSearchRequest, AnySearchSearchResponse } from '../types.js';
/** Stable model-facing name for full AnySearch search requests. */
export declare const ANYSEARCH_SEARCH_TOOL_NAME = "anysearch_search";
/** Initial model-visible content budget; deployment config may replace it. */
export declare const DEFAULT_MAX_RENDERED_CONTENT_CHARS = 12000;
interface ParsedSearchArgs {
    request: AnySearchSearchRequest;
    includeContent: boolean;
}
/** Validate value constraints that the current Tool schema DSL cannot express. */
export declare function parseAdvancedSearchArgs(args: {
    query: string;
    maxResults?: number;
    tag?: string;
    params?: Record<string, JsonValue>;
    zone?: 'cn' | 'intl';
    language?: string;
    includeContent?: boolean;
}): ParsedSearchArgs;
/** Format one bounded canonical result for the model. */
export declare function formatAdvancedSearchOutput(result: Pick<AnySearchSearchResponse, 'requestId' | 'results' | 'metadata'> & Partial<Pick<AnySearchSearchResponse, 'contentTruncated' | 'sourcesTruncated'>> & {
    renderedContentTruncated: boolean;
}, includeContent: boolean, maxRenderedContentChars: number): string;
/** Defensively bound canonical source fields and included content. */
export declare function normalizeSearchOutput(response: Pick<AnySearchSearchResponse, 'results' | 'metadata'> & Partial<Pick<AnySearchSearchResponse, 'requestId' | 'sourcesTruncated' | 'contentTruncated'>>, includeContent: boolean): {
    value: Pick<AnySearchSearchResponse, 'requestId' | 'results' | 'metadata'>;
    truncated: boolean;
};
/** Streaming whole-output writer; links are retained atomically. */
export declare function createSearchOutputWriter(budget: number, initialTruncated?: boolean): {
    paragraph(...chunks: string[]): boolean;
    source(item: AnySearchSearchResponse['results'][number]): boolean;
    markTruncated(): void;
    finish(): { text: string; truncated: boolean };
};
/** Register full AnySearch search on the Harness tool registry. */
export declare function registerAdvancedSearchTool(ctx: Context, client: AnySearchClient, maxRenderedContentChars: number): void;
export {};
