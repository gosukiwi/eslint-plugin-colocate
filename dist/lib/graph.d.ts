import ts from "typescript";
export declare const SOURCE_EXTS: readonly [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
export declare function isTestFile(relPath: string): boolean;
export interface Graph {
    importers: Map<string, string[]>;
    files: string[];
}
export type VisitToken = object;
export declare const SKIP_DIRS: Set<string>;
export declare function isSourceFile(p: string): boolean;
export declare function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean;
export declare function isOutsideRoot(relPath: string): boolean;
export declare function isExcludedPath(relPath: string, ignoreGlobs: string[]): boolean;
export declare function parseSourceFile(fileName: string, content: string): ts.SourceFile;
export interface ResolutionSettings {
    options: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
    configPaths: string[];
}
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
export declare function getGraphResolutionSettings(graph: Graph, rootDir: string): ResolutionSettings;
export declare function findTsconfig(rootDir: string): string | undefined;
export declare function resolveSpecifier(specifier: string, fromDir: string, settings?: ResolutionSettings): string | undefined;
export declare function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph;
export declare const REVALIDATE_AFTER_MS = 100;
export declare function stampIsAmbiguous(mtimeMs: number, builtAt: number, coarseTimestamps: boolean): boolean;
export declare function getGraph(rootDir: string, ignoreGlobs: string[], currentFile: string, visitToken?: VisitToken): Graph;
