import type { Graph } from "./graph.js";
export declare function isEntryFile(filePath: string): boolean;
export declare const getGates: ((graph: Graph) => ReadonlyMap<string, string>) & {
    prime: (graph: Graph, value: ReadonlyMap<string, string>) => void;
};
export interface CrossedGate {
    dir: string;
    entry: string;
}
export declare function findCrossedGate(target: string, importer: string, graph: Graph, rootDir: string): CrossedGate | undefined;
