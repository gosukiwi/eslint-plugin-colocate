import { type ResolutionSettings } from "./resolve.js";
export interface Graph {
    readonly importers: ReadonlyMap<string, readonly string[]>;
    readonly files: readonly string[];
}
export declare function graphHasFile(graph: Graph, filePath: string): boolean;
export declare function graphFilesInDir(graph: Graph, dir: string): readonly string[];
export declare function canonicalGraphPath(graph: Graph, filePath: string): string;
export declare const getGraphResolutionSettings: ((graph: Graph) => ResolutionSettings) & {
    prime: (graph: Graph, value: ResolutionSettings) => void;
};
export declare function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph;
export declare function buildGraphFromFiles(files: readonly string[], resolvedRoot: string): {
    graph: Graph;
    configPaths: string[];
};
export declare function buildGraphWithConfigs(rootDir: string, ignoreGlobs: string[]): {
    graph: Graph;
    configPaths: string[];
};
