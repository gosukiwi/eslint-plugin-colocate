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
    if (matchesIgnore(relPath, ignore)) {
      continue;
    }

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

function hasCompanionStylesheet(dir: string): boolean {
  return safeReaddir(dir).some((entry) => {
    if (!isStylesheet(entry.name)) {
      return false;
    }
    return entry.isSymbolicLink()
      ? (safeStat(path.join(dir, entry.name))?.isFile() ?? false)
      : entry.isFile();
  });
}

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

  const { local, total } = collectReExports(indexFile, dir, ctx.graph);
  if (local.length !== 1 || total !== 1) {
    return false;
  }
  if (!graphHasFile(ctx.graph, local[0])) {
    return false;
  }

  const target = local[0];
  return path.basename(target, path.extname(target)) !== path.basename(dir);
}

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

  const lintedBase = path.basename(
    subject.lintedPath,
    path.extname(subject.lintedPath),
  );
  if (lintedBase === "index" && isMismatchedEntry(file, ctx)) {
    findings.push("mismatchedEntry");
  }

  return findings;
}
