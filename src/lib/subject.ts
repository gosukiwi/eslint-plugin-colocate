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
  readonly ignore: string[];
  graph(): Graph;
  covers(filePath: string): boolean;
  display(filePath: string): string;
}

interface SubjectOptions {
  root?: string;
  ignore?: string[];
}

const resolvedLintRoots = new Map<
  string,
  { rootDir: string; realRootDir: string }
>();

const fileRealpathsByParse = new WeakMap<object, string | undefined>();

export function resolvedLintRoot(
  cwd: string,
  rootOption: string,
): { rootDir: string; realRootDir: string } | undefined {
  const key = cwd + "\0" + rootOption;
  const cached = resolvedLintRoots.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const rootDir = resolveRootDir(rootOption, cwd);
  const realRootDir = safeRealpath(rootDir);
  if (realRootDir === undefined) {
    return undefined;
  }

  const resolved = { rootDir, realRootDir };
  resolvedLintRoots.set(key, resolved);
  return resolved;
}

export function resolveSubject(context: Rule.RuleContext): Subject | undefined {
  const options = (context.options[0] ?? {}) as SubjectOptions;
  const root = options.root ?? ".";
  const ignore = options.ignore ?? [];

  if (!isSourceFile(context.filename)) {
    return undefined;
  }

  const resolved = resolvedLintRoot(context.cwd, root);
  if (resolved === undefined) {
    return undefined;
  }

  const parse = context.sourceCode;
  let file: string | undefined;
  if (fileRealpathsByParse.has(parse)) {
    file = fileRealpathsByParse.get(parse);
  } else {
    file = safeRealpath(context.filename);
    fileRealpathsByParse.set(parse, file);
  }

  if (file === undefined) {
    return undefined;
  }

  const { rootDir, realRootDir } = resolved;
  if (!isInGraphScope(path.relative(realRootDir, file), ignore)) {
    return undefined;
  }

  let graph: Graph | undefined;
  return {
    rootDir,
    realRootDir,
    file,
    ignore,
    graph: () =>
      (graph ??= getGraph(rootDir, ignore, file, context.sourceCode)),
    covers: (filePath) =>
      isSourceFile(filePath) &&
      isInGraphScope(path.relative(realRootDir, filePath), ignore),
    display: (filePath) =>
      path.relative(realRootDir, filePath).split(path.sep).join("/"),
  };
}
