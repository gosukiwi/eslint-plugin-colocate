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
  dirs: Set<string>,
  dirStamps: Map<string, { mtimeMs: number; ctimeMs: number; size: number }>,
  ancestorRealDirs: Set<string>,
  linkedRealDirs: Set<string>,
  behindLink: boolean,
): void {
  const realDir = safeRealpath(dir);
  if (realDir === undefined || ancestorRealDirs.has(realDir)) {
    return;
  }
  dirs.add(dir);
  const stat = safeStat(dir);
  if (stat !== undefined) {
    dirStamps.set(dir, {
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    });
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
        dirs,
        dirStamps,
        nested,
        linkedRealDirs,
        behindLink || isLink,
      );
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(relPath)) {
      files.add(realPath);
      if (isLink && fullPath !== realPath) {
        files.add(fullPath);
      }
    }
  }
}

export function collectSourceFiles(
  resolvedRoot: string,
  ignoreGlobs: string[],
): {
  files: string[];
  dirs: string[];
  dirStamps: Map<string, { mtimeMs: number; ctimeMs: number; size: number }>;
} {
  const collected = new Set<string>();
  const walkedDirs = new Set<string>();
  const dirStamps = new Map<
    string,
    { mtimeMs: number; ctimeMs: number; size: number }
  >();
  walkDir(
    resolvedRoot,
    resolvedRoot,
    ignoreGlobs,
    collected,
    walkedDirs,
    dirStamps,
    new Set(),
    new Set(),
    false,
  );
  return {
    files: [...collected].sort(),
    dirs: [...walkedDirs].sort(),
    dirStamps,
  };
}
