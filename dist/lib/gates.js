import path from "node:path";
const gatesByGraph = new WeakMap();
/**
 * Structural on purpose. The ownership model only treats an `index` as an entry
 * when code outside the directory imports through it, because a convenience
 * barrel over loose helpers must not redraw ownership boundaries. Access is the
 * other question: a door is a door the moment it exists, or adding one would
 * gate nothing until every consumer had already migrated to it.
 */
export function isEntryFile(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    return base === "index" || base === path.basename(path.dirname(filePath));
}
/**
 * Every gated directory mapped to the entry that names it. `index` wins over a
 * directory-named sibling regardless of which the walk sees first: it is the
 * door that makes the bare directory specifier resolve, so it is the shorter
 * fix to suggest. Between two `index` spellings (a migration in progress) the
 * first one in the sorted `graph.files` wins - a real ordering artefact, not a
 * meaningful choice between them.
 */
export function getGates(graph) {
    const cached = gatesByGraph.get(graph);
    if (cached !== undefined) {
        return cached;
    }
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
    gatesByGraph.set(graph, gates);
    return gates;
}
// Duplicated rather than imported from owners.ts: sharing it would make the
// access model depend on the ownership model for a one-line predicate, and
// drag typescript/minimatch into this file for nothing.
function isInsideDir(filePath, dir) {
    // A dir that already ends in the separator is the filesystem root, where
    // naive concatenation builds "//" and matches nothing - so the importer
    // looked outside a gate it was plainly inside. Reachable because
    // resolveRootDir returns an absolute root verbatim, so root: "/" survives.
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return filePath.startsWith(prefix);
}
/**
 * The innermost gate containing `target` but not `importer`, or undefined when
 * no boundary separates them.
 *
 * Walking up from the target finds the innermost one directly: a deeper gate
 * always nests inside a shallower one, so an importer inside the deeper gate is
 * inside the shallower one too. The first directory that both gates the target
 * and excludes the importer is therefore the innermost such gate.
 *
 * Precondition: `target`, `importer`, and `rootDir` must already be in the
 * graph's own casing. `rootDir` comes from config and is compared only against
 * itself, so it needs no help. Neither `target` nor `importer` is canonical on
 * arrival on a case-insensitive disk: `resolveSpecifier` hands back whatever
 * casing the specifier text used, and `fs.realpathSync` does not fold case, so
 * the linted path ESLint reports carries whatever casing invoked it. Pass both
 * through `canonicalGraphPath` first - a non-canonical `importer` makes
 * `isInsideDir` miss, which reports a file for reaching into the very
 * directory it lives in and names a fix that would import its own door.
 */
export function findCrossedGate(target, importer, graph, rootDir) {
    // Checked against the file itself, not against the gate map: a directory with
    // both doors maps only to its index, and `Dir/Dir.ts` is still a legal target.
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
