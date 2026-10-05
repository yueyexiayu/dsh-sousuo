/** Register AnySearch providers and opt-in advanced tools on the official web seam. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Config } from './config.js';
export { resolveConfig } from './config.js';
export type { Config, ResolvedConfig } from './config.js';
export { SEARCH_FOLLOWTHROUGH_FOOTER, SEARCH_FOLLOWTHROUGH_SECTION } from './followthrough.js';
/** Cordis plugin name used in loader diagnostics. */
export declare const name = "sousuo";
/** Capability seams required by the providers, prompt section, and advanced tools. */
export declare const inject: string[];
export declare const Config: z<Config>;
/** Register providers; ordinary web tools remain owned by the official tool-web plugin. */
export declare function apply(ctx: Context, config: Config): void;
