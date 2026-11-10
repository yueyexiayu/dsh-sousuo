/** AnySearch plugin configuration accepted by resolveConfig and apply. */
export interface Config {
    /** HTTPS API base URL. Defaults to the public AnySearch API. */
    baseURL?: string;
    /** Local key file override for programmatic configuration. */
    keysPath?: string;
    /** Rotation-state path; defaults to state.json beside keysPath. */
    statePath?: string;
    /** Aggregate content characters rendered by one advanced tool operation. */
    maxRenderedContentChars?: number;
    /** Register the three AnySearch-specific tools. Defaults to false. */
    advancedTools?: boolean;
}
export interface ResolvedConfig {
    baseURL: string;
    keysPath: string;
    statePath: string;
    maxRenderedContentChars: number;
    advancedTools: boolean;
}
export declare function resolveConfig(config?: Config): ResolvedConfig;
