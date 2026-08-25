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
 * The graph's own casing for a resolved path, or the path unchanged when the
 * filesystem is case-sensitive. `fs.realpathSync` (what `safeRealpath` uses)
 * does not fold case on macOS - only the `.native` variant does - so a path
 * fresh out of `resolveSpecifier` carries whatever casing the specifier text
 * used, not the casing the file actually has on disk. Callers that key off a
 * file's directory (gates, ownership) need the latter or they miss real
 * boundaries and invent fake ones.
 */
export declare function canonicalGraphPath(graph: Graph, filePath: string): string;
export declare function getGraphResolutionSettings(graph: Graph, rootDir: string): ResolutionSettings;
export declare function findTsconfig(rootDir: string): string | undefined;
export declare function resolveSpecifier(specifier: string, fromDir: string, settings?: ResolutionSettings): string | undefined;
export declare function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph;
export declare const REVALIDATE_AFTER_MS = 100;
export declare function stampIsAmbiguous(mtimeMs: number, builtAt: number, coarseTimestamps: boolean): boolean;
export declare function getGraph(rootDir: string, ignoreGlobs: string[], currentFile: string, visitToken?: VisitToken): Graph;
