import { type Graph } from "./graph.js";
export interface OwnershipContext {
    graph: Graph;
    rootDir: string;
    layerDirs: string[];
    shellGlobs: string[];
}
export declare function collectLocalReExports(indexFile: string, dir: string): string[];
export declare function countLocalReExports(indexFile: string, dir: string): number;
export interface Owner {
    kind: "folder" | "standalone";
    path: string;
}
export declare function getOwner(filePath: string, graph: Graph, rootDir: string): Owner;
export declare function getShells(ctx: OwnershipContext): Set<string>;
export declare function getColocationConsumers(filePath: string, graph: Graph, shells: Set<string>): string[];
export declare function collectLayerDirectories(cwd: string, layerGlobs: string[]): string[];
export declare function resolveLayerDirectories(graph: Graph, cwd: string, layerGlobs: string[]): string[];
export declare function isLayerPublicModule(filePath: string, layerDirs: string[]): boolean;
export declare function shouldSkipColocation(filePath: string, ctx: OwnershipContext): boolean;
export declare function isPrivateOutsideOwner(filePath: string, ctx: OwnershipContext): boolean;
export declare function getSharedColocationIssue(filePath: string, ctx: OwnershipContext): "sharedTooHigh" | "sharedInsideOwner" | undefined;
