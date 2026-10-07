/** Model-facing bounded fanout over independent AnySearch search requests. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AnySearchClientError } from "../client.js";
import { ANYSEARCH_TOOL_TIMEOUT_MS, MAX_DIAGNOSTIC_CHARS, MAX_SOURCE_TITLE_CHARS, MAX_UPSTREAM_ERROR_CHARS } from "../limits.js";
import { createSearchOutputWriter, normalizeSearchOutput, parseAdvancedSearchArgs } from "./search.js";
/** Stable model-facing name for bounded client-side search fanout. */
export const ANYSEARCH_BATCH_SEARCH_TOOL_NAME = 'anysearch_batch_search';
/** Maximum independent HTTP requests accepted by one batch operation. */
export const MAX_BATCH_SEARCH_ITEMS = 5;
const inputItemSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        query: { type: 'string', required: true, description: 'Search query.' },
        maxResults: { type: 'integer', description: 'Result count from 1 to 20.' },
        tag: { type: 'string', description: 'Exact vertical tag returned by anysearch_capabilities.' },
        params: { type: 'object', additionalProperties: true, description: 'Scalar parameters declared for the tag.' },
        zone: { type: 'string', enum: ['cn', 'intl'], description: 'Search region.' },
        language: { type: 'string', description: 'Provider language hint.' },
        includeContent: { type: 'boolean', description: 'Include cleaned content within the shared batch budget.' },
    },
};
const resultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string', required: true },
        url: { type: 'string', required: true },
        snippet: { type: 'string' },
        content: { type: 'string' },
    },
};
const metadataSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        totalResults: { type: 'integer', required: true },
        searchTimeMs: { type: 'integer', required: true },
    },
};
const successSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        index: { type: 'integer', required: true },
        query: { type: 'string', required: true },
        ok: { type: 'boolean', const: true, required: true },
        requestId: { type: 'string' },
        results: { type: 'array', required: true, items: resultSchema },
        metadata: { ...metadataSchema, required: true },
    },
};
const failureSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        index: { type: 'integer', required: true },
        query: { type: 'string', required: true },
        ok: { type: 'boolean', const: false, required: true },
        error: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
                message: { type: 'string', required: true },
                httpStatus: { type: 'integer' },
                requestId: { type: 'string' },
                retryAfter: { type: 'string' },
            },
        },
    },
};
const outputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: { type: 'array', required: true, items: { oneOf: [successSchema, failureSchema] } },
        summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
                total: { type: 'integer', required: true },
                succeeded: { type: 'integer', required: true },
                failed: { type: 'integer', required: true },
            },
        },
        renderedContentTruncated: { type: 'boolean', required: true },
    },
};
/** Validate every batch item before any HTTP request begins. */
export function parseBatchSearchItems(items) {
    if (items.length === 0)
        throw new Error('items must contain at least one search');
    if (items.length > MAX_BATCH_SEARCH_ITEMS) {
        throw new Error(`items must contain at most ${MAX_BATCH_SEARCH_ITEMS} searches`);
    }
    return items.map((item) => {
        const parsed = parseAdvancedSearchArgs(item);
        return { request: parsed.request, includeContent: parsed.includeContent };
    });
}
/** Render ordered batch outcomes with one aggregate whole-output budget. */
export function formatBatchSearchOutput(args, output, maxRenderedContentChars) {
    return renderBatchSearchOutput(args, output, maxRenderedContentChars).text;
}
function renderBatchSearchOutput(args, output, maxRenderedContentChars) {
    const normalized = normalizeBatchOutput(args, output);
    const value = normalized.value;
    const writer = createSearchOutputWriter(maxRenderedContentChars, normalized.truncated);
    writer.paragraph(`AnySearch batch completed: ${value.summary.succeeded} succeeded, ${value.summary.failed} failed.`);
    writer.paragraph('Each item is an independent HTTP request with independent quota and rate-limit evaluation.');
    for (const item of value.items) {
        writer.paragraph(`## ${item.index + 1}. `, item.query);
        if (!item.ok) {
            writer.paragraph('Failed: ', item.error.message);
            continue;
        }
        if (item.requestId !== undefined)
            writer.paragraph('Request ID: ', item.requestId);
        if (item.results.length === 0) {
            writer.paragraph(item.metadata.totalResults > 0 || output.renderedContentTruncated ? 'No usable source URLs retained.' : 'No results found.');
            continue;
        }
        writer.paragraph('Sources:');
        const cited = new Set();
        for (const result of item.results) {
            if (writer.source(result)) cited.add(result);
        }
        if (args.items[item.index]?.includeContent !== true) continue;
        for (const result of item.results) {
            if (!result.content) continue;
            if (!cited.has(result)) { writer.markTruncated(); continue; }
            writer.paragraph('### ', result.title || result.url, '\n', result.content);
        }
    }
    return writer.finish();
}
function normalizeBatchOutput(args, output) {
    let truncated = output.renderedContentTruncated === true || output.items.length > MAX_BATCH_SEARCH_ITEMS;
    const items = output.items.slice(0, MAX_BATCH_SEARCH_ITEMS).map(item => {
        const query = item.query.slice(0, MAX_SOURCE_TITLE_CHARS);
        if (query.length !== item.query.length) truncated = true;
        const base = { index: item.index, query, ok: item.ok };
        if (item.ok) {
            const result = normalizeSearchOutput(item, args.items[item.index]?.includeContent === true);
            if (result.truncated) truncated = true;
            return { ...base, ...result.value };
        }
        const message = item.error.message.slice(0, MAX_UPSTREAM_ERROR_CHARS);
        const requestId = item.error.requestId?.slice(0, MAX_DIAGNOSTIC_CHARS);
        const retryAfter = item.error.retryAfter?.slice(0, MAX_DIAGNOSTIC_CHARS);
        if (message.length !== item.error.message.length || requestId?.length !== item.error.requestId?.length
            || retryAfter?.length !== item.error.retryAfter?.length) truncated = true;
        return { ...base, error: { message,
            ...item.error.httpStatus === undefined ? {} : { httpStatus: item.error.httpStatus },
            ...requestId === undefined ? {} : { requestId },
            ...retryAfter === undefined ? {} : { retryAfter } } };
    });
    const { total, succeeded, failed } = output.summary;
    if (![total, succeeded, failed].every(value => Number.isSafeInteger(value) && value >= 0))
        throw new Error('AnySearch returned invalid batch metadata');
    return { value: { items, summary: { total, succeeded, failed } }, truncated };
}
/** Execute validated items concurrently while preserving independent failures and input order. */
export async function executeBatchSearch(client, parsed, signal, maxRenderedContentChars) {
    if (parsed.length === 0 || parsed.length > MAX_BATCH_SEARCH_ITEMS)
        throw new Error(`items must contain one to ${MAX_BATCH_SEARCH_ITEMS} searches`);
    let canonicalContentTruncated = false;
    const items = await Promise.all(parsed.map(async (item, index) => {
        try {
            const response = await client.search(item.request, signal);
            const normalized = normalizeSearchOutput(response, item.includeContent);
            if (normalized.truncated) canonicalContentTruncated = true;
            return { index, query: item.request.query, ok: true, ...normalized.value };
        }
        catch (error) {
            if (error instanceof AnySearchClientError && error.kind === 'aborted')
                throw error;
            return batchFailure(index, item.request.query, error);
        }
    }));
    const failed = items.filter(item => !item.ok).length;
    const args = { items: parsed.map(item => ({ includeContent: item.includeContent })) };
    const normalized = normalizeBatchOutput(args, {
        items, summary: { total: items.length, succeeded: items.length - failed, failed },
        renderedContentTruncated: canonicalContentTruncated,
    });
    const output = { ...normalized.value, renderedContentTruncated: normalized.truncated };
    output.renderedContentTruncated = renderBatchSearchOutput(args, output, maxRenderedContentChars).truncated;
    return output;
}
/** Register bounded client-side batch search on the Harness tool registry. */
export function registerBatchSearchTool(ctx, client, maxRenderedContentChars) {
    ctx.tools.register(defineTool({
        name: ANYSEARCH_BATCH_SEARCH_TOOL_NAME,
        timeoutMs: ANYSEARCH_TOOL_TIMEOUT_MS,
        description: 'Run one to five independent AnySearch searches concurrently. Results stay in input order and an item failure does not discard other results.',
        parameters: {
            items: {
                type: 'array',
                required: true,
                items: inputItemSchema,
                description: 'One to five search requests. Discover vertical tags with anysearch_capabilities first.',
            },
        },
        output: {
            schema: outputSchema,
            render: (args, value) => [{
                    type: 'text',
                    text: formatBatchSearchOutput(args, value, maxRenderedContentChars),
                }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const parsed = parseBatchSearchItems(args.items);
            return executeBatchSearch(client, parsed, exec.signal, maxRenderedContentChars);
        },
        presentCall: (args) => ({
            card: 'generic',
            title: `AnySearch batch (${args.items.length})`,
            kind: 'search',
            rawInput: args.items.map(item => item.query).join('\n'),
        }),
    }));
}
function batchFailure(index, query, error) {
    if (!(error instanceof AnySearchClientError)) {
        return { index, query, ok: false, error: { message: 'AnySearch search failed' } };
    }
    return {
        index,
        query,
        ok: false,
        error: {
            message: error.message,
            ...error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus },
            ...error.requestId === undefined ? {} : { requestId: error.requestId },
            ...error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter },
        },
    };
}
