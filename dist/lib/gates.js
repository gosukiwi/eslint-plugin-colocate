import path from "node:path";
import { derivedFromGraph } from "./derived.js";
import { isInsideDir } from "./paths.js";
export function isEntryFile(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    return base === "index" || base === path.basename(path.dirname(filePath));
}
export const getGates = derivedFromGraph((graph) => {
    const gates = new Map();
    for (const file of graph.files) {
        if (!isEntryFile(file)) {
            continue;
        }
        const dir = path.dirname(file);
        const isIndex = path.basename(file, path.extname(file)) === "index";
        const existing = gates.get(dir);
        const existingIsIndex = existing !== undefined &&
            path.basename(existing, path.extname(existing)) === "index";
        if (existing === undefined || (isIndex && !existingIsIndex)) {
            gates.set(dir, file);
        }
    }
    return gates;
});
export function findCrossedGate(target, importer, graph, rootDir) {
    if (isEntryFile(target)) {
        return undefined;
    }
    const gates = getGates(graph);
    let dir = path.dirname(target);
    while (true) {
        const entry = gates.get(dir);
        if (entry !== undefined && !isInsideDir(importer, dir)) {
            return { dir, entry };
        }
        if (dir === rootDir) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}
