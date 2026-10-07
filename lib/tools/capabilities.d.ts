/** Model-facing discovery tool for AnySearch's dynamic capability catalog. */
import type { Context } from '@deepseek-ai/cordis';
import type { AnySearchClient } from '../client.js';
import type { AnySearchDomainsResponse, AnySearchSubDomainsResponse } from '../types.js';
export declare const ANYSEARCH_CAPABILITIES_TOOL_NAME = "anysearch_capabilities";
export declare function parseCapabilityDomains(domains: string[]): string[];
/** Entire rendered catalog, including notices and footer, fits the budget. */
export declare function formatDomains(result: AnySearchDomainsResponse & { truncated?: boolean }, maxRenderedContentChars?: number): string;
export declare function formatSubDomains(result: AnySearchSubDomainsResponse & { truncated?: boolean }, maxRenderedContentChars?: number): string;
export type CapabilitiesOutput = ((AnySearchDomainsResponse & { kind: 'domains' })
    | (AnySearchSubDomainsResponse & { kind: 'sub_domains' })) & { truncated: boolean };
export declare function registerCapabilitiesTool(ctx: Context, client: AnySearchClient, maxRenderedContentChars?: number): void;
