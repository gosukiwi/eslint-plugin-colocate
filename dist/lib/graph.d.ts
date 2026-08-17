import ts from "typescript";
export declare const SOURCE_EXTS: readonly [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
export declare function isTestFile(p: string): boolean;
export interface Graph {
    importers: Map<string, string[]>;
    files: string[];
}
export declare const SKIP_DIRS: Set<string>;
export declare function isSourceFile(p: string): boolean;
export declare function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean;
export declare function parseSourceFile(fileName: string, content: string): ts.SourceFile;
export interface PathAlias {
    prefix: string;
    mappedPrefix: string;
}
export declare function resolveSpecifier(specifier: string, fromDir: string, aliases?: PathAlias[]): string | undefined;
export declare function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph;
export declare function getGraph(rootDir: string, ignoreGlobs: string[], currentFile: string): Graph;
