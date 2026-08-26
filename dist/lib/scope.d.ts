export declare const SOURCE_EXTS: readonly [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
export declare const SKIP_DIRS: Set<string>;
export declare function isSourceFile(p: string): boolean;
export declare function isTestFile(relPath: string): boolean;
export declare function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean;
export declare function isOutsideRoot(relPath: string): boolean;
export declare function isExcludedPath(relPath: string, ignoreGlobs: string[]): boolean;
/**
 * Whether a path relative to the root names a file the walk would have
 * collected. The one statement of graph membership: the rules ask it whether the
 * linted file is a subject at all and whether a resolved target is in the model,
 * and the graph cache asks it whether an unstamped file is one the walk should
 * have picked up.
 *
 * Four inline copies of this disjunction is exactly how `isInsideDir` came to
 * exist in three copies sharing one defect - fixing one left the others wrong.
 * Do not reintroduce a local copy.
 */
export declare function isInGraphScope(relPath: string, ignoreGlobs: string[]): boolean;
