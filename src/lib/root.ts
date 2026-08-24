import path from "node:path";
import { safeStat } from "./fs-safe.js";

// A relative root is resolved against the working directory, but ESLint may be
// invoked from anywhere - a subdirectory, via lint-staged, from a monorepo script.
// Resolving "src" against cwd alone meant the directory was simply not found from
// a subdirectory, and a missing root reports nothing, so the rule went quiet
// instead of complaining. Walk up until the configured root exists.
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
    // Stop at the project it belongs to. Unbounded, the walk would happily
    // resolve root: "src" to a checkout's parent directory that happens to be
    // called src, taking unrelated projects into the graph and making the
    // findings depend on where the repository sits on disk.
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
