export declare const SOURCE_EXTS: readonly [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
export declare const SKIP_DIRS: Set<string>;
export declare function isSourceFile(p: string): boolean;
export declare function isTestFile(relPath: string): boolean;
export declare function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean;
export declare function isOutsideRoot(relPath: string): boolean;
export declare function isExcludedPath(relPath: string, ignoreGlobs: string[]): boolean;
export declare function isInGraphScope(relPath: string, ignoreGlobs: string[]): boolean;
