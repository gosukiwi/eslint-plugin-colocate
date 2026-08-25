import path from "node:path";
import { minimatch } from "minimatch";

export const SOURCE_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
] as const;

const DECLARATION_EXTS = [".d.ts", ".d.mts", ".d.cts"] as const;

export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".hg",
  ".svn",
]);

export function isSourceFile(p: string): boolean {
  if (DECLARATION_EXTS.some((ext) => p.endsWith(ext))) {
    return false;
  }
  return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}

// Takes a path relative to the root: given an absolute one, a `__tests__`
// directory anywhere ABOVE the project would have disabled the rule entirely.
export function isTestFile(relPath: string): boolean {
  return (
    relPath.split(path.sep).includes("__tests__") ||
    /\.(test|spec)\./.test(path.basename(relPath))
  );
}

export function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean {
  const normalized = relPath.split(path.sep).join("/");
  return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}

export function isOutsideRoot(relPath: string): boolean {
  return (
    relPath === "" ||
    relPath === ".." ||
    // Not startsWith("..") - a directory named "..data" (Kubernetes mounts one)
    // is inside the root.
    relPath.startsWith(".." + path.sep) ||
    path.isAbsolute(relPath)
  );
}

// A file is excluded when it, or any directory above it, is skipped or ignored -
// which is what walkDir does as it descends. Checking only the file's own path
// let an ignore glob naming a directory ("gen" rather than "gen/**") pass, and
// never consulted SKIP_DIRS at all.
export function isExcludedPath(relPath: string, ignoreGlobs: string[]): boolean {
  const segments = relPath.split(path.sep);
  for (let i = 1; i <= segments.length; i += 1) {
    if (SKIP_DIRS.has(segments[i - 1])) {
      return true;
    }
    if (matchesIgnore(segments.slice(0, i).join(path.sep), ignoreGlobs)) {
      return true;
    }
  }
  return false;
}
