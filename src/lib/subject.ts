import path from "node:path";
import type { Rule } from "eslint";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import type { Graph } from "./graph.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";

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

interface SubjectOptions {
  root?: string;
  ignore?: string[];
}

/**
 * `undefined` when there is nothing to say about this file: a root that is not
 * on disk, a linted path that is not a real file (processors,
 * `--stdin-filename`, a file deleted mid-run), or a file outside the model.
 * Tolerant rather than throwing, since none of those is the user's mistake.
 */
export function resolveSubject(context: Rule.RuleContext): Subject | undefined {
  const options = (context.options[0] ?? {}) as SubjectOptions;
  const ignore = options.ignore ?? [];

  if (!isSourceFile(context.filename)) {
    return undefined;
  }

  const rootDir = resolveRootDir(options.root ?? ".", context.cwd);
  const realRootDir = safeRealpath(rootDir);
  const file = safeRealpath(context.filename);
  if (realRootDir === undefined || file === undefined) {
    return undefined;
  }

  // Deliberate asymmetry: resolved targets are extension-tested by `covers`,
  // but the linted file is only scope-tested here - the extension check already
  // happened on the path ESLint handed over, so a `.ts` symlink pointing at a
  // `.txt` file is still a subject.
  if (!isInGraphScope(path.relative(realRootDir, file), ignore)) {
    return undefined;
  }

  let graph: Graph | undefined;
  return {
    rootDir,
    realRootDir,
    file,
    ignore,
    graph: () => (graph ??= getGraph(rootDir, ignore, file, context.sourceCode)),
    covers: (filePath) =>
      isSourceFile(filePath) &&
      isInGraphScope(path.relative(realRootDir, filePath), ignore),
    display: (filePath) =>
      path.relative(realRootDir, filePath).split(path.sep).join("/"),
  };
}
