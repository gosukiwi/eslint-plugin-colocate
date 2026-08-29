import { type Graph } from "./graph.js";
export interface OwnershipContext {
    graph: Graph;
    rootDir: string;
    layerDirs: string[];
}
export interface ReExports {
    /** Sibling modules in the same directory, one entry per module. */
    local: string[];
    /** Every re-exported module, including modules from elsewhere. */
    total: number;
}
export declare function collectReExports(indexFile: string, dir: string, graph: Graph): ReExports;
export interface Owner {
    kind: "folder" | "standalone";
    path: string;
}
export declare function getOwner(filePath: string, graph: Graph, rootDir: string): Owner;
export declare const getShells: ((graph: Graph) => Set<string>) & {
    prime: (graph: Graph, value: Set<string>) => void;
};
export declare function getColocationConsumers(filePath: string, graph: Graph, shells: Set<string>): string[];
export declare function collectLayerDirectories(cwd: string, layerGlobs: string[], rootDir?: string): string[];
export declare function resolveLayerDirectories(graph: Graph, cwd: string, layerGlobs: string[], rootDir?: string): string[];
export declare function isLayerPublicModule(filePath: string, layerDirs: string[]): boolean;
export declare function shouldSkipColocation(filePath: string, ctx: OwnershipContext): boolean;
export declare function isPrivateOutsideOwner(filePath: string, ctx: OwnershipContext): boolean;
export declare function getSharedColocationIssue(filePath: string, ctx: OwnershipContext): "sharedTooHigh" | "sharedInsideOwner" | undefined;
