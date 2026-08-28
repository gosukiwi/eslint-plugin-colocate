import path from "node:path";
import { safeReaddir, safeStat } from "./fs-safe.js";
import { graphHasFile } from "./graph.js";
import {
  collectReExports,
  getSharedColocationIssue,
  isPrivateOutsideOwner,
  resolveLayerDirectories,
  type OwnershipContext,
} from "./owners.js";
import {
  isSourceFile,
  isTestFile,
  matchesIgnore,
  SKIP_DIRS,
} from "./scope.js";
import type { Subject } from "./subject.js";

/**
 * Everything `colocate/ownership` can say about a file.
 *
 * The two decisions below - is this directory a singleton wrapper, is this index
 * a stand-in for one sibling - lived in the rule until they were moved here, for
 * the reason `gates.ts` exists: a rule file should read as an adapter between
 * ESLint and a model, and the model should be answerable (and testable) without
 * one. `owners.ts` holds the predicates that answer "who owns this file" from the
 * import graph; this module holds what the rule *reports* and in which order,
 * plus the two questions no other caller asks - one of which is a directory walk
 * that never touches the graph at all.
 */
export type OwnershipFinding =
  | "singletonFolder"
  | "privateOutsideOwner"
  | "sharedTooHigh"
  | "sharedInsideOwner"
  | "mismatchedEntry";

const STYLESHEET_EXTS = [".css", ".scss", ".sass", ".less", ".styl"] as const;

function isStylesheet(filePath: string): boolean {
  const basename = path.basename(filePath);
  return STYLESHEET_EXTS.some((ext) => basename.endsWith(ext));
}

function countSourceFilesRecursive(
  dir: string,
  rootDir: string,
  ignore: string[],
): number {
  let sourceCount = 0;

  for (const entry of safeReaddir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    // Files excluded from the graph must not count here either, or an ignored
    // generated file keeps a wrapper directory looking populated.
    if (matchesIgnore(relPath, ignore)) {
      continue;
    }

    // Symlinks read as neither file nor directory, so a linked subdirectory of
    // sources used to leave the parent looking like a single-file wrapper.
    const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
    const isDirectory = entry.isSymbolicLink()
      ? (stat?.isDirectory() ?? false)
      : entry.isDirectory();

    if (isDirectory) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      sourceCount += countSourceFilesRecursive(fullPath, rootDir, ignore);
      continue;
    }

    const isFile = entry.isSymbolicLink()
      ? (stat?.isFile() ?? false)
      : entry.isFile();
    if (!isFile) {
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(relPath)) {
      sourceCount += 1;
    }
  }

  return sourceCount;
}

// Only beside the file: a stylesheet several directories down is not a
// companion, and treating it as one silently exempted the wrapper.
function hasCompanionStylesheet(dir: string): boolean {
  return safeReaddir(dir).some((entry) => {
    if (!isStylesheet(entry.name)) {
      return false;
    }
    // readdir reports a symlink as neither file nor directory.
    return entry.isSymbolicLink()
      ? (safeStat(path.join(dir, entry.name))?.isFile() ?? false)
      : entry.isFile();
  });
}

/**
 * Whether `dir` holds nothing but this one file, which could therefore live in
 * the parent directory instead.
 *
 * Answered from disk rather than from the graph on purpose: the question is what
 * the directory contains, and a source file nobody imports is still content.
 */
function isSingletonWrapperDirectory(
  dir: string,
  filename: string,
  rootDir: string,
  ignore: string[],
): boolean {
  if (
    countSourceFilesRecursive(dir, rootDir, ignore) !== 1 ||
    hasCompanionStylesheet(dir)
  ) {
    return false;
  }

  const dirName = path.basename(dir);
  const fileBasename = path.basename(filename, path.extname(filename));
  return fileBasename === dirName || fileBasename === "index";
}

/**
 * Whether outside code enters this directory through a barrel that only stands
 * in for one differently-named sibling, so the sibling should be imported (or
 * renamed) directly.
 *
 * Precondition: `indexFile` is an index file (see `ownershipFindings`, which is
 * where that is decided, and why it is decided of the linted path).
 */
function isMismatchedEntry(indexFile: string, ctx: OwnershipContext): boolean {
  const dir = path.dirname(indexFile);
  if (dir === ctx.rootDir) {
    return false;
  }

  const filesInDir = ctx.graph.files.filter(
    (file) => path.dirname(file) === dir,
  );

  const outsideImporters = new Set<string>();
  let allOutsideImportsTargetIndex = true;

  for (const fileInDir of filesInDir) {
    const importers = ctx.graph.importers.get(fileInDir) ?? [];
    for (const importer of importers) {
      const importerDir = path.dirname(importer);
      if (importerDir === dir) {
        continue;
      }

      outsideImporters.add(importer);
      if (fileInDir !== indexFile) {
        allOutsideImportsTargetIndex = false;
      }
    }
  }

  if (outsideImporters.size === 0 || !allOutsideImportsTargetIndex) {
    return false;
  }

  const { local, total } = collectReExports(
    indexFile,
    dir,
    ctx.graph,
    ctx.rootDir,
  );
  // An index that also re-exports modules from elsewhere is an aggregator,
  // not a stand-in for one sibling: the message would name a "named entry
  // file" that does not exist and dropping the barrel would lose the rest.
  if (local.length !== 1 || total !== 1) {
    return false;
  }
  // Only modules the graph knows about, so the message cannot point at a
  // file the user has excluded.
  if (!graphHasFile(ctx.graph, local[0])) {
    return false;
  }

  // Re-exporting the directory's own named entry keeps the folder a real
  // owner; the barrel only makes `./Foo` resolve to `Foo/Foo.ts`.
  const target = local[0];
  return path.basename(target, path.extname(target)) !== path.basename(dir);
}

/**
 * Every finding for this file, **in report order**.
 *
 * The order is part of the contract, not an accident of how this reads: the
 * fixture assertions sort, but `check:placement` prints a per-placement matrix of
 * raw sequences and the differential compares raw output, so reordering these
 * four pushes would show up as a diff with no behaviour behind it.
 *
 * Nothing here short-circuits, again deliberately: a file can be a singleton
 * wrapper *and* misplaced relative to its owner, and each report names a
 * different edit.
 */
export function ownershipFindings(
  subject: Subject,
  cwd: string,
  layers: string[],
): OwnershipFinding[] {
  const { realRootDir: rootDir, file, ignore } = subject;
  const dir = path.dirname(file);
  const graph = subject.graph();
  const ctx: OwnershipContext = {
    graph,
    rootDir,
    layerDirs: resolveLayerDirectories(graph, cwd, layers, rootDir),
  };
  const findings: OwnershipFinding[] = [];

  if (
    dir !== rootDir &&
    isSingletonWrapperDirectory(dir, file, rootDir, ignore)
  ) {
    findings.push("singletonFolder");
  }

  if (isPrivateOutsideOwner(file, ctx)) {
    findings.push("privateOutsideOwner");
  }

  const sharedIssue = getSharedColocationIssue(file, ctx);
  if (sharedIssue !== undefined) {
    findings.push(sharedIssue);
  }

  // Asked of `lintedPath` rather than of the realpathed `file`, which is what
  // this decision has always keyed on - see `Subject.lintedPath`. Everything
  // below it is about the real directory.
  const lintedBase = path.basename(
    subject.lintedPath,
    path.extname(subject.lintedPath),
  );
  if (lintedBase === "index" && isMismatchedEntry(file, ctx)) {
    findings.push("mismatchedEntry");
  }

  return findings;
}
