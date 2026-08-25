import { type Graph } from "./graph.js";
export type VisitToken = object;
export declare const REVALIDATE_AFTER_MS = 100;
export declare function stampIsAmbiguous(mtimeMs: number, builtAt: number, coarseTimestamps: boolean): boolean;
/**
 * The graph for `rootDir`, built once per process and revalidated once per lint
 * pass.
 *
 * `visitToken` should be `context.sourceCode`: ESLint hands every rule the
 * identical object for one parse of a file and a new object for every subsequent
 * parse, so it is what lets a second rule asking about the same file skip
 * revalidation entirely rather than merely avoid tripping the pass-boundary
 * check (see runRules in ESLint's linter, which builds one shared rule-context
 * base per file and extends it per rule; verified this holds across ESLint 9 and
 * 10, under `--cache`, `lintText`, and a processor splitting one file into
 * several blocks). Omitting it - a direct call from a test, a single-rule setup
 * that only ever asks once per file - keeps the original, more conservative
 * behaviour, where every repeat of a file counts as a new pass.
 */
export declare function getGraph(rootDir: string, ignoreGlobs: string[], currentFile: string, visitToken?: VisitToken): Graph;
