import type { Graph } from "./graph.js";
export declare function derivedFromGraph<T, A extends unknown[] = []>(build: (graph: Graph, ...args: A) => T): ((graph: Graph, ...args: A) => T) & {
    prime: (graph: Graph, value: T) => void;
};
