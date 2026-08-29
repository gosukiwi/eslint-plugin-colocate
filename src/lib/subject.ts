import path from "node:path";
import type { Rule } from "eslint";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import { type Graph } from "./graph.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";

function hasSymlinkAliasImporter(graph: Graph, realFile: string): boolean {
  for (const file of graph.files) {
    if (file === realFile) {
      continue;
    }
    if (safeRealpath(file) !== realFile) {
      continue;
    }
    if ((graph.importers.get(file) ?? []).length > 0) {
      return true;
    }
  }
  return false;
}

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

  const graph = getGraph(rootDir, ignore, file, context.sourceCode);
  if (
    file === context.filename &&
    hasSymlinkAliasImporter(graph, file) &&
    (graph.importers.get(file) ?? []).length === 0
  ) {
    return undefined;
  }

  return {
    rootDir,
    realRootDir,
    file,
    lintedPath: context.filename,
    ignore,
    graph: () => graph,
    covers: (filePath) =>
      isSourceFile(filePath) &&
      isInGraphScope(path.relative(realRootDir, filePath), ignore),
    display: (filePath) =>
      path.relative(realRootDir, filePath).split(path.sep).join("/"),
  };
}
