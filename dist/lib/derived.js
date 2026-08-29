export function derivedFromGraph(build) {
    const table = new WeakMap();
    const get = (graph, ...args) => {
        let value = table.get(graph);
        if (value === undefined) {
            value = build(graph, ...args);
            table.set(graph, value);
        }
        return value;
    };
    get.prime = (graph, value) => {
        table.set(graph, value);
    };
    return get;
}
