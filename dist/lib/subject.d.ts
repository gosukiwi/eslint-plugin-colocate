import type { Rule } from "eslint";
import type { Graph } from "./graph.js";
/**
 * The file a rule has been asked about, once it is known to be one the model can
 * talk about at all.
 *
 * Both rules opened with the same preamble - default the root, resolve it
 * against a cwd that may be anywhere, realpath it and the linted file, tolerate
 * either being absent, then reject the file for being outside the root, a test,
 * or excluded. Two copies of that is how `isInsideDir` came to exist in three
 * copies sharing one defect; do not reintroduce a local one.
 */
export interface Subject {
    /**
     * The configured root, resolved but deliberately NOT realpathed: it is half
     * the graph cache key, so realpathing it here would give a symlinked root a
     * second cache entry and change when the graph is rebuilt.
     */
    readonly rootDir: string;
    /** The same root, realpathed - what every path comparison uses. */
    readonly realRootDir: string;
    /** The linted file, realpathed. */
    readonly file: string;
    /**
     * The same file under the path ESLint handed over, NOT realpathed. Every path
     * comparison uses `file`; this exists because ownership's `mismatchedEntry`
     * decision asks "is this an index?" of the linted path and always has, and a
     * symlink named `index.ts` pointing at a differently-named module answers the
     * two questions differently. Do not reach for it for anything else.
     */
    readonly lintedPath: string;
    readonly ignore: string[];
    /**
     * Built on first use and memoised for this file, so a file that asks nothing
     * never pays for the graph and a file that asks repeatedly pays once. Supplies
     * `context.sourceCode` as `getGraph`'s visit token, which is what lets both
     * rules share one revalidation of the same parse.
     */
    graph(): Graph;
    /** Whether a resolved path is a file the model can talk about. */
    covers(filePath: string): boolean;
    /** Posix-relative to the root, for report message data. */
    display(filePath: string): string;
}
/**
 * `undefined` when there is nothing to say about this file: a root that is not
 * on disk, a linted path that is not a real file (processors,
 * `--stdin-filename`, a file deleted mid-run), or a file outside the model.
 * Tolerant rather than throwing, since none of those is the user's mistake.
 */
export declare function resolveSubject(context: Rule.RuleContext): Subject | undefined;
