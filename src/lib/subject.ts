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

const subjectsByParse = new WeakMap<
  object,
  Map<string, Subject | undefined>
>();

const subjectGraphs = new WeakMap<Subject, () => void>();

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

function subjectOptionsKey(root: string, ignore: string[]): string {
  return root + "\0" + ignore.join("\0");
}

export function resolveSubject(context: Rule.RuleContext): Subject | undefined {
  const options = (context.options[0] ?? {}) as SubjectOptions;
  const root = options.root ?? ".";
  const ignore = options.ignore ?? [];
  const key = subjectOptionsKey(root, ignore);

  let byOptions = subjectsByParse.get(context.sourceCode);
  if (byOptions === undefined) {
    byOptions = new Map();
    subjectsByParse.set(context.sourceCode, byOptions);
  }
  if (byOptions.has(key)) {
    const cached = byOptions.get(key);
    if (cached !== undefined) {
      subjectGraphs.get(cached)?.();
    }
    return cached;
  }

  let subject: Subject | undefined;

  if (isSourceFile(context.filename)) {
    const resolved = resolvedLintRoot(context.cwd, root);
    const file = safeRealpath(context.filename);
    if (
      resolved !== undefined &&
      file !== undefined &&
      isInGraphScope(path.relative(resolved.realRootDir, file), ignore)
    ) {
      const { rootDir, realRootDir } = resolved;
      let graph: Graph | undefined;
      subject = {
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
      subjectGraphs.set(subject, () => {
        graph = undefined;
      });
    }
  }

  byOptions.set(key, subject);
  return subject;
}
