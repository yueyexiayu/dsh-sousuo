/** Model-facing discovery tool for AnySearch's dynamic capability catalog. */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createSearchOutputWriter } from './search.js';
import { ANYSEARCH_TOOL_TIMEOUT_MS, DEFAULT_MAX_RENDERED_CONTENT_CHARS,
    MAX_CANONICAL_CONTENT_CHARS, MAX_DIAGNOSTIC_CHARS, MAX_SOURCE_SNIPPET_CHARS } from '../limits.js';
/** Stable model-facing name for dynamic AnySearch capability discovery. */
export const ANYSEARCH_CAPABILITIES_TOOL_NAME = 'anysearch_capabilities';
const MAX_CAPABILITY_DOMAINS = 5;
const domainSummarySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        domain: { type: 'string', required: true },
        description: { type: 'string', required: true },
        subDomainCount: { type: 'integer', required: true },
    },
};
const subDomainSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        subDomain: { type: 'string', required: true },
        description: { type: 'string', required: true },
        params: { type: 'object', required: true, additionalProperties: true },
    },
};
const domainCapabilitySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        domain: { type: 'string', required: true },
        description: { type: 'string', required: true },
        subDomains: { type: 'array', required: true, items: subDomainSchema },
    },
};
const capabilitiesOutputSchema = {
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: { type: 'string', const: 'domains', required: true },
                requestId: { type: 'string' },
                domains: { type: 'array', required: true, items: domainSummarySchema },
                truncated: { type: 'boolean', required: true },
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                kind: { type: 'string', const: 'sub_domains', required: true },
                requestId: { type: 'string' },
                domains: { type: 'array', required: true, items: domainCapabilitySchema },
                truncated: { type: 'boolean', required: true },
            },
        },
    ],
};
/** Validate, trim, and deduplicate a model-supplied domain list. */
export function parseCapabilityDomains(domains) {
    if (domains.length === 0)
        throw new Error('domains must contain at least one domain');
    if (domains.length > MAX_CAPABILITY_DOMAINS) {
        throw new Error(`domains must contain at most ${MAX_CAPABILITY_DOMAINS} domains`);
    }
    const seen = new Set();
    const parsed = [];
    for (const raw of domains) {
        const domain = raw.trim();
        if (domain.length === 0)
            throw new Error('domains must not contain blank values');
        if (seen.has(domain))
            continue;
        seen.add(domain);
        parsed.push(domain);
    }
    return parsed;
}
/** Render the top-level domain catalog within the complete model-visible text budget. */
export function formatDomains(result, maxRenderedContentChars = DEFAULT_MAX_RENDERED_CONTENT_CHARS) {
    return renderCapabilitiesOutput('domains', result, maxRenderedContentChars).text;
}
/** Render detailed dynamic parameters without guessing or shortening declared identifiers. */
export function formatSubDomains(result, maxRenderedContentChars = DEFAULT_MAX_RENDERED_CONTENT_CHARS) {
    return renderCapabilitiesOutput('sub_domains', result, maxRenderedContentChars).text;
}
/** Retain a bounded catalog projection; omitted identifiers are never renamed into different API fields. */
function projectCapabilitiesOutput(kind, result, budget) {
    let remaining = Math.min(budget, MAX_CANONICAL_CONTENT_CHARS);
    let truncated = result.truncated === true;
    const requestId = result.requestId?.slice(0, Math.min(remaining, MAX_DIAGNOSTIC_CHARS));
    if (requestId !== undefined) remaining -= requestId.length;
    if (requestId?.length !== result.requestId?.length) truncated = true;
    // Account for node overhead as well as text, so even thousands of empty descriptions stay bounded.
    const nodeOverhead = 64;
    function identifier(name) {
        if (name.length + nodeOverhead > remaining) { truncated = true; return false; }
        remaining -= name.length + nodeOverhead;
        return true;
    }
    function description(text) {
        const shown = text.slice(0, Math.min(remaining, MAX_SOURCE_SNIPPET_CHARS));
        remaining -= shown.length;
        if (shown.length !== text.length) truncated = true;
        return shown;
    }
    const domains = [];
    for (const domain of result.domains) {
        if (remaining < nodeOverhead) { truncated = true; break; }
        if (!identifier(domain.domain)) break;
        const projected = { domain: domain.domain, description: description(domain.description) };
        domains.push(projected);
        if (kind === 'domains') {
            projected.subDomainCount = domain.subDomainCount;
            continue;
        }
        projected.subDomains = [];
        for (const subDomain of domain.subDomains) {
            if (remaining < nodeOverhead) { truncated = true; break; }
            if (!identifier(subDomain.subDomain)) break;
            const params = Object.create(null);
            projected.subDomains.push({ subDomain: subDomain.subDomain,
                description: description(subDomain.description), params });
            // Enumerate incrementally instead of materializing all unretained parameter entries.
            for (const name in subDomain.params) {
                if (!Object.hasOwn(subDomain.params, name)) continue;
                if (remaining < nodeOverhead || !identifier(name)) { truncated = true; break; }
                const info = subDomain.params[name];
                params[name] = { description: description(info.description), required: info.required,
                    ...info.sortOrder === undefined ? {} : { sortOrder: info.sortOrder } };
            }
        }
    }
    return { kind, ...requestId === undefined ? {} : { requestId }, domains, truncated };
}
function renderCapabilitiesOutput(kind, result, budget) {
    // The same projection also protects standalone formatter callers that bypass the client.
    const value = projectCapabilitiesOutput(kind, result, budget);
    const writer = createSearchOutputWriter(budget, value.truncated);
    // Probe the shared writer's reserved notices/footer once, without duplicating their implementation.
    let remaining = budget - createSearchOutputWriter(budget, true).finish().text.length;
    function paragraph(...chunks) {
        const complete = writer.paragraph(...chunks);
        remaining -= 2 + chunks.reduce((total, chunk) => total + chunk.length, 0);
        return complete;
    }
    function namedParagraph(prefix, name, suffix, text) {
        if (2 + prefix.length + name.length + suffix.length > remaining) {
            writer.markTruncated();
            return false;
        }
        return paragraph(prefix, name, suffix, text);
    }
    const empty = value.domains.length === 0;
    const heading = empty && value.truncated
        ? 'No catalog entries fit the response or rendering limit.'
        : kind === 'domains'
            ? empty ? 'No AnySearch domains are currently available.' : 'Available AnySearch domains:'
            : empty ? 'No matching AnySearch domains were found.' : 'AnySearch vertical capabilities:';
    if (!paragraph(heading)) return writer.finish();
    if (value.requestId !== undefined && !paragraph('Request ID: ', value.requestId)) return writer.finish();
    catalog: for (const domain of value.domains) {
        if (kind === 'domains') {
            if (!namedParagraph('- ', domain.domain, ` (${domain.subDomainCount} sub-domains): `, domain.description)) break;
            continue;
        }
        if (!namedParagraph('- ', domain.domain, ': ', domain.description)) break;
        for (const subDomain of domain.subDomains) {
            if (!namedParagraph('  - ', subDomain.subDomain, ': ', subDomain.description)) break catalog;
            // Only bounded retained entries are sorted; upstream declaration order breaks equal-order ties.
            const params = Object.entries(subDomain.params)
                .sort((left, right) => (left[1].sortOrder ?? Number.MAX_SAFE_INTEGER)
                    - (right[1].sortOrder ?? Number.MAX_SAFE_INTEGER));
            for (const [name, info] of params) {
                if (!namedParagraph('    - ', name, info.required ? ' (required): ' : ': ', info.description)) break catalog;
            }
        }
    }
    if (kind === 'sub_domains' && !empty) {
        paragraph('Use the exact sub-domain as anysearch_search.tag and pass only declared params.');
    }
    return writer.finish();
}
/** Register dynamic capability discovery on the Harness tool registry. */
export function registerCapabilitiesTool(ctx, client, maxRenderedContentChars = DEFAULT_MAX_RENDERED_CONTENT_CHARS) {
    ctx.tools.register(defineTool({
        name: ANYSEARCH_CAPABILITIES_TOOL_NAME,
        timeoutMs: ANYSEARCH_TOOL_TIMEOUT_MS,
        description: 'Discover current AnySearch domains, vertical tags, and parameter definitions. Call without domains for the top-level catalog, then with up to five selected domains before using a vertical tag.',
        parameters: {
            domains: {
                type: 'array',
                items: { type: 'string' },
                description: 'Up to five top-level domain names. Omit to list all top-level domains.',
            },
        },
        output: {
            schema: capabilitiesOutputSchema,
            render: (_args, value) => [{
                    type: 'text',
                    text: renderCapabilitiesOutput(value.kind, value, maxRenderedContentChars).text,
                }],
            presentationMeta: (_args, value) => ({
                truncated: renderCapabilitiesOutput(value.kind, value, maxRenderedContentChars).truncated,
            }),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const kind = args.domains === undefined ? 'domains' : 'sub_domains';
            const result = kind === 'domains'
                ? await client.listDomains(exec.signal)
                : await client.getSubDomains(parseCapabilityDomains(args.domains), exec.signal);
            const value = projectCapabilitiesOutput(kind, result, maxRenderedContentChars);
            value.truncated = renderCapabilitiesOutput(kind, value, maxRenderedContentChars).truncated;
            return value;
        },
        presentCall: (args) => ({
            card: 'generic',
            title: args.domains === undefined ? 'AnySearch domains' : `AnySearch: ${args.domains.join(', ')}`,
            kind: 'search',
            rawInput: args.domains?.join(', ') ?? 'all domains',
        }),
    }));
}
