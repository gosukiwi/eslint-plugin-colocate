import type { Graph } from "./graph.js";
/**
 * Structural on purpose. The ownership model only treats an `index` as an entry
 * when code outside the directory imports through it, because a convenience
 * barrel over loose helpers must not redraw ownership boundaries. Access is the
 * other question: a door is a door the moment it exists, or adding one would
 * gate nothing until every consumer had already migrated to it.
 */
export declare function isEntryFile(filePath: string): boolean;
/**
 * Every gated directory mapped to the entry that names it. `index` wins over a
 * directory-named sibling regardless of which the walk sees first: it is the
 * door that makes the bare directory specifier resolve, so it is the shorter
 * fix to suggest. Between two `index` spellings (a migration in progress) the
 * first one in the sorted `graph.files` wins - a real ordering artefact, not a
 * meaningful choice between them.
 */
export declare const getGates: ((graph: Graph) => ReadonlyMap<string, string>) & {
    prime: (graph: Graph, value: ReadonlyMap<string, string>) => void;
};
export interface CrossedGate {
    dir: string;
    entry: string;
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
export declare function findCrossedGate(target: string, importer: string, graph: Graph, rootDir: string): CrossedGate | undefined;
