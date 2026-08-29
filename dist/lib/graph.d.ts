import { type ResolutionSettings } from "./resolve.js";
/**
 * Readonly because six indexes are derived from a graph and memoised against
 * the graph object for its whole lifetime (see derived.ts): mutating `files` or
 * `importers` in place would silently desync every one of them. A changed tree
 * produces a NEW graph - which is also what drops the old indexes, since
 * nothing invalidates them.
 */
export interface Graph {
    readonly importers: ReadonlyMap<string, readonly string[]>;
    readonly files: readonly string[];
}
/**
 * Whether the graph contains this exact path.
 *
 * Exact on purpose: a caller asking "does the model know this module" is
 * checking a path it got from the graph or from `collectReExports`, and folding
 * would answer for a different file. Use `canonicalGraphPath` first when the
 * path came from a specifier instead.
 */
export declare function graphHasFile(graph: Graph, filePath: string): boolean;
/**
 * The graph's own spelling of a resolved path, or the path unchanged when
 * nothing in the graph matches it.
 *
 * `resolveSpecifier` hands back a path built from the specifier's own text, and
 * `fs.realpathSync` (what `safeRealpath` uses) neither folds case on macOS - only
 * its `.native` variant does - nor normalizes Unicode on any platform. So a path
 * that resolved perfectly well can still differ byte-for-byte from the one the
 * walk recorded. Callers that key off a file's directory (gates) need the
 * recorded spelling or they miss real boundaries and invent fake ones.
 */
export declare function canonicalGraphPath(graph: Graph, filePath: string): string;
export declare const getGraphResolutionSettings: ((graph: Graph) => ResolutionSettings) & {
    prime: (graph: Graph, value: ResolutionSettings) => void;
};
export declare function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph;
export declare function buildGraphWithConfigs(rootDir: string, ignoreGlobs: string[]): {
    graph: Graph;
    configPaths: string[];
};
