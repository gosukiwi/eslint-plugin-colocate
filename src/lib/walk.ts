import type { Dirent } from "node:fs";
import path from "node:path";
import {
  classifyDirEntry,
  safeReaddir,
  safeRealpath,
  safeStat,
} from "./fs-safe.js";
import { isAtOrInsideDir } from "./paths.js";
import {
  isExcludedPath,
  isSourceFile,
  isTestFile,
  matchesIgnore,
  SKIP_DIRS,
} from "./scope.js";

interface DirStamp {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

function stampDir(dir: string, dirStamps: Map<string, DirStamp>): void {
  const stat = safeStat(dir);
  if (stat !== undefined) {
    dirStamps.set(dir, {
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    });
  }
}

function resolveWalkRealPath(
  fullPath: string,
  followLink: boolean,
  rootDir: string,
  ignoreGlobs: string[],
): string | undefined {
  if (!followLink) {
    return fullPath;
  }
  const realPath = safeRealpath(fullPath);
  if (realPath === undefined || realPath === fullPath) {
    return realPath;
  }
  if (!isAtOrInsideDir(realPath, rootDir)) {
    return undefined;
  }
  if (isExcludedPath(path.relative(rootDir, realPath), ignoreGlobs)) {
    return undefined;
  }
  return realPath;
}

interface WalkContext {
  rootDir: string;
  ignoreGlobs: string[];
  files: Set<string>;
  dirStamps: Map<string, DirStamp>;
  linkedRealDirs: Set<string>;
  behindLink: boolean;
}

function visitDirectory(
  fullPath: string,
  realPath: string,
  isLink: boolean,
  ctx: WalkContext,
  nested: Set<string>,
): void {
  if (isLink) {
    if (ctx.linkedRealDirs.has(realPath)) {
      return;
    }
    ctx.linkedRealDirs.add(realPath);
  }
  walkDir(
    fullPath,
    ctx.rootDir,
    ctx.ignoreGlobs,
    ctx.files,
    ctx.dirStamps,
    nested,
    ctx.linkedRealDirs,
    ctx.behindLink || isLink,
  );
}

function collectFileEntry(
  fullPath: string,
  realPath: string,
  relPath: string,
  isLink: boolean,
  files: Set<string>,
): void {
  if (!isSourceFile(fullPath) || isTestFile(relPath)) {
    return;
  }
  files.add(realPath);
  if (isLink && fullPath !== realPath) {
    files.add(fullPath);
  }
}

function visitEntry(
  entry: Dirent,
  dir: string,
  ctx: WalkContext,
  nested: Set<string>,
): void {
  const fullPath = path.join(dir, entry.name);
  const relPath = path.relative(ctx.rootDir, fullPath);
  const kind = classifyDirEntry(entry, fullPath);
  if (kind === "other") {
    return;
  }
  if (SKIP_DIRS.has(entry.name) || matchesIgnore(relPath, ctx.ignoreGlobs)) {
    return;
  }
  const isLink = entry.isSymbolicLink();
  const realPath = resolveWalkRealPath(
    fullPath,
    isLink || ctx.behindLink,
    ctx.rootDir,
    ctx.ignoreGlobs,
  );
  if (realPath === undefined) {
    return;
  }
  if (kind === "directory") {
    visitDirectory(fullPath, realPath, isLink, ctx, nested);
    return;
  }
  collectFileEntry(fullPath, realPath, relPath, isLink, ctx.files);
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreGlobs: string[],
  files: Set<string>,
  dirStamps: Map<string, DirStamp>,
  ancestorRealDirs: Set<string>,
  linkedRealDirs: Set<string>,
  behindLink: boolean,
): void {
  const realDir = safeRealpath(dir);
  if (realDir === undefined || ancestorRealDirs.has(realDir)) {
    return;
  }
  stampDir(dir, dirStamps);
  const nested = new Set(ancestorRealDirs).add(realDir);
  const ctx: WalkContext = {
    rootDir,
    ignoreGlobs,
    files,
    dirStamps,
    linkedRealDirs,
    behindLink,
  };
  for (const entry of safeReaddir(dir)) {
    visitEntry(entry, dir, ctx, nested);
  }
}

export function collectSourceFiles(
  resolvedRoot: string,
  ignoreGlobs: string[],
): {
  files: string[];
  dirStamps: Map<string, DirStamp>;
} {
  const collected = new Set<string>();
  const dirStamps = new Map<string, DirStamp>();
  walkDir(
    resolvedRoot,
    resolvedRoot,
    ignoreGlobs,
    collected,
    dirStamps,
    new Set(),
    new Set(),
    false,
  );
  return {
    files: [...collected].sort(),
    dirStamps,
  };
}
