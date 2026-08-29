import path from "node:path";
export function isInsideDir(filePath, dir) {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return filePath.startsWith(prefix);
}
export function isAtOrInsideDir(filePath, dir) {
    return filePath === dir || isInsideDir(filePath, dir);
}
