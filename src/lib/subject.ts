import path from "node:path";
import type { Rule } from "eslint";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import type { Graph } from "./graph.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";

export interface Subject {
  readonly rootDir: string;
  readonly realRootDir: string;
  readonly file: string;
  readonly lintedPath: string;
  readonly ignore: string[];
  graph(): Graph;
  covers(filePath: string): boolean;
  display(filePath: string): string;
}

interface SubjectOptions {
  root?: string;
  ignore?: string[];
}

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

  if (!isInGraphScope(path.relative(realRootDir, file), ignore)) {
    return undefined;
  }

  let graph: Graph | undefined;
  return {
    rootDir,
    realRootDir,
    file,
    lintedPath: context.filename,
    ignore,
    graph: () => (graph ??= getGraph(rootDir, ignore, file, context.sourceCode)),
    covers: (filePath) =>
      isSourceFile(filePath) &&
      isInGraphScope(path.relative(realRootDir, filePath), ignore),
    display: (filePath) =>
      path.relative(realRootDir, filePath).split(path.sep).join("/"),
  };
}
