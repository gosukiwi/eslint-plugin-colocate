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
export function derivedFromGraph(build) {
    const table = new WeakMap();
    // Keyed on the graph alone, so extra arguments feed the first build only.
    // That is honest for a build input the graph itself determines - a graph
    // object belongs to exactly one (root, ignore) pair - and wrong for anything
    // that can genuinely differ per call (see resolveLayerDirectories, which keys
    // those inside its own value).
    //
    // Note the root's *spelling* does vary between callers: entry.ts hands
    // getGraphResolutionSettings `subject.rootDir` while owners.ts hands it
    // `subject.realRootDir`. That is safe for two reasons, not one - the builder
    // realpaths its argument before use, and buildGraphWithConfigs primes the
    // entry on every path that produces a graph with files in it - so do not read
    // this as licence to pass a per-call value.
    const get = (graph, ...args) => {
        let value = table.get(graph);
        if (value === undefined) {
            value = build(graph, ...args);
            table.set(graph, value);
        }
        return value;
    };
    // For a caller that already holds the index and would otherwise pay to have
    // it rebuilt on first use.
    get.prime = (graph, value) => {
        table.set(graph, value);
    };
    return get;
}
