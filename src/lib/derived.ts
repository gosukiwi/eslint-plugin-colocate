import type { Graph } from "./graph.js";

export function derivedFromGraph<T, A extends unknown[] = []>(
  build: (graph: Graph, ...args: A) => T,
): ((graph: Graph, ...args: A) => T) & {
  prime: (graph: Graph, value: T) => void;
} {
  const table = new WeakMap<Graph, T>();
  const get = (graph: Graph, ...args: A): T => {
    let value = table.get(graph);
    if (value === undefined) {
      value = build(graph, ...args);
      table.set(graph, value);
    }
    return value;
  };
  get.prime = (graph: Graph, value: T): void => {
    table.set(graph, value);
  };
  return get;
}
