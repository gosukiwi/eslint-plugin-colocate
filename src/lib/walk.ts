import path from "node:path";
import { safeReaddir, safeRealpath, safeStat } from "./fs-safe.js";
import { isAtOrInsideDir } from "./paths.js";
import {
  isExcludedPath,
  isSourceFile,
  isTestFile,
  matchesIgnore,
  SKIP_DIRS,
} from "./scope.js";

function walkDir(
  dir: string,
  rootDir: string,
  ignoreGlobs: string[],
  files: Set<string>,
  ancestorRealDirs: Set<string>,
  linkedRealDirs: Set<string>,
  behindLink: boolean,
): void {
  const realDir = safeRealpath(dir);
  if (realDir === undefined || ancestorRealDirs.has(realDir)) {
    return;
  }
  const nested = new Set(ancestorRealDirs).add(realDir);

  for (const entry of safeReaddir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
    const isDirectory = entry.isSymbolicLink()
      ? (stat?.isDirectory() ?? false)
      : entry.isDirectory();
    const isFile = entry.isSymbolicLink()
      ? (stat?.isFile() ?? false)
      : entry.isFile();

    if (!isDirectory && !isFile) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name) || matchesIgnore(relPath, ignoreGlobs)) {
      continue;
    }

    const isLink = entry.isSymbolicLink();
    const realPath = isLink || behindLink ? safeRealpath(fullPath) : fullPath;
    if (realPath === undefined) {
      continue;
    }
    if (realPath !== fullPath) {
      if (!isAtOrInsideDir(realPath, rootDir)) {
        continue;
      }
      if (isExcludedPath(path.relative(rootDir, realPath), ignoreGlobs)) {
        continue;
      }
    }

    if (isDirectory) {
      if (isLink) {
        if (linkedRealDirs.has(realPath)) {
          continue;
        }
        linkedRealDirs.add(realPath);
      }
      walkDir(
        fullPath,
        rootDir,
        ignoreGlobs,
        files,
        nested,
        linkedRealDirs,
        behindLink || isLink,
      );
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(relPath)) {
      files.add(realPath);
    }
  }
}

export function collectSourceFiles(
  resolvedRoot: string,
  ignoreGlobs: string[],
): string[] {
  const collected = new Set<string>();
  walkDir(
    resolvedRoot,
    resolvedRoot,
    ignoreGlobs,
    collected,
    new Set(),
    new Set(),
    false,
  );
  return [...collected].sort();
}
