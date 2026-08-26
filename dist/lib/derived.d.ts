import type { Graph } from "./graph.js";
/**
 * An index derived from a graph, memoised for exactly as long as that graph
 * lives.
 *
 * Six hand-rolled `WeakMap<Graph, X>` tables repeating one get/undefined/build/
 * set dance had accumulated across three modules (resolution settings, the
 * member set, the folded-path index, gates, shells, layer directories). The
 * lifetime rule all six rely on is worth stating once: a graph is immutable
 * (see `Graph`), so an index built from one stays true for as long as that
 * object exists, and a changed tree produces a *new* graph object whose indexes
 * are therefore empty. Nothing needs invalidating, and nothing here keeps a
 * graph alive - the table is weak.
 */
export declare function derivedFromGraph<T, A extends unknown[] = []>(build: (graph: Graph, ...args: A) => T): ((graph: Graph, ...args: A) => T) & {
    prime: (graph: Graph, value: T) => void;
};
