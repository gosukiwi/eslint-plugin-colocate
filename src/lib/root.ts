import path from "node:path";
import { safeStat } from "./fs-safe.js";

function isProjectBoundary(dir: string): boolean {
  return (
    safeStat(path.join(dir, "package.json")) !== undefined ||
    safeStat(path.join(dir, ".git")) !== undefined
  );
}

export function resolveRootDir(rootOption: string, cwd: string): string {
  if (path.isAbsolute(rootOption)) {
    return rootOption;
  }

  let dir = cwd;
  while (true) {
    const candidate = path.resolve(dir, rootOption);
    if (safeStat(candidate)?.isDirectory() === true) {
      return candidate;
    }
    if (isProjectBoundary(dir)) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return path.resolve(cwd, rootOption);
}
