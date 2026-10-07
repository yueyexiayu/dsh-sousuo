/** AnySearch implementation of the DeepSeek Harness web search provider. */
import { WebError } from '@deepseek-ai/dsh-web';
import { AnySearchClientError } from './client.js';
import { MAX_NATIVE_SEARCH_CHARS, MAX_SEARCH_RESULTS, MAX_SOURCE_TITLE_CHARS,
    MAX_SOURCE_SNIPPET_CHARS, MAX_SOURCE_URL_CHARS } from './limits.js';
/** Stable provider id selected through `ctx.web`. */
export const ANYSEARCH_PROVIDER_ID = 'sousuo';
/** Map a validated AnySearch result into the provider-neutral web source. */
export function mapAnySearchResult(result) {
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.href.length > MAX_SOURCE_URL_CHARS) {
        throw new TypeError('AnySearch source must be a bounded absolute HTTP(S) URL without credentials');
    }
    const title = result.title.trim().slice(0, MAX_SOURCE_TITLE_CHARS).replace(/[\r\n]/gu, ' ');
    const snippet = result.snippet?.trim().slice(0, MAX_SOURCE_SNIPPET_CHARS).replace(/[\r\n]/gu, ' ');
    return {
        url: url.href,
        ...title.length > 0 ? { title } : {},
        ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    };
}
/** Bound the native projection because DSH's native search renderer has no character cap. */
export function mapAnySearchResponse(response) {
    // Reserve notices, separators, cite instruction and the native truncation note.
    let remaining = MAX_NATIVE_SEARCH_CHARS - 512;
    let truncated = response.sourcesTruncated === true || response.results.length > MAX_SEARCH_RESULTS;
    const sources = [];
    for (const result of response.results.slice(0, MAX_SEARCH_RESULTS)) {
        const source = mapAnySearchResult(result);
        if (result.title.trim().length > MAX_SOURCE_TITLE_CHARS
            || (result.snippet?.trim().length ?? 0) > MAX_SOURCE_SNIPPET_CHARS) truncated = true;
        const label = source.title ?? new URL(source.url).hostname;
        // Native format is '- [label](url) — snippet' plus a newline.
        const fixed = label.length + source.url.length + 8;
        if (fixed > remaining) { truncated = true; continue; }
        const snippetBudget = Math.max(0, remaining - fixed - 3);
        if (source.snippet !== undefined && source.snippet.length > snippetBudget) {
            source.snippet = source.snippet.slice(0, snippetBudget);
            if (source.snippet.length === 0) delete source.snippet;
            truncated = true;
        }
        remaining -= fixed + (source.snippet === undefined ? 0 : source.snippet.length + 3);
        sources.push(source);
    }
    return { sources, truncated };
}
/** Search provider backed by the shared AnySearch HTTP client. */
export class AnySearchProvider {
    client;
    id = ANYSEARCH_PROVIDER_ID;
    constructor(client) { this.client = client; }
    available() { return this.client.available(); }
    async search(request, signal) {
        try {
            return mapAnySearchResponse(await this.client.search({
                query: request.query,
                ...request.maxResults === undefined ? {} : { maxResults: request.maxResults },
            }, signal));
        } catch (error) {
            if (error instanceof AnySearchClientError && error.kind === 'aborted') {
                throw new WebError('AnySearch search aborted', 'WEB_ABORTED', { cause: error });
            }
            throw new WebError(error instanceof Error ? error.message : `AnySearch search failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
}
