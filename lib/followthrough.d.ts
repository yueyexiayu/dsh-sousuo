import type { Context } from '@deepseek-ai/cordis';
export declare const SEARCH_FOLLOWTHROUGH_SECTION: string;
export declare const SEARCH_FOLLOWTHROUGH_FOOTER: string;
export declare function withSearchFollowthrough(text: string): string;
export declare function registerSearchFollowthrough(ctx: Context): void;
