import path from "node:path";

export function isInsideDir(filePath: string, dir: string): boolean {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return filePath.startsWith(prefix);
}

export function isAtOrInsideDir(filePath: string, dir: string): boolean {
  return filePath === dir || isInsideDir(filePath, dir);
}
