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
];
const DECLARATION_EXTS = [".d.ts", ".d.mts", ".d.cts"];
export const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "coverage",
    ".git",
    ".hg",
    ".svn",
]);
export function isSourceFile(p) {
    if (DECLARATION_EXTS.some((ext) => p.endsWith(ext))) {
        return false;
    }
    return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}
// Takes a path relative to the root: given an absolute one, a `__tests__`
// directory anywhere ABOVE the project would have disabled the rule entirely.
export function isTestFile(relPath) {
    return (relPath.split(path.sep).includes("__tests__") ||
        /\.(test|spec)\./.test(path.basename(relPath)));
}
export function matchesIgnore(relPath, ignoreGlobs) {
    const normalized = relPath.split(path.sep).join("/");
    return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}
export function isOutsideRoot(relPath) {
    return (relPath === "" ||
        relPath === ".." ||
        // Not startsWith("..") - a directory named "..data" (Kubernetes mounts one)
        // is inside the root.
        relPath.startsWith(".." + path.sep) ||
        path.isAbsolute(relPath));
}
// A file is excluded when it, or any directory above it, is skipped or ignored -
// which is what walkDir does as it descends. Checking only the file's own path
// let an ignore glob naming a directory ("gen" rather than "gen/**") pass, and
// never consulted SKIP_DIRS at all.
export function isExcludedPath(relPath, ignoreGlobs) {
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
/**
 * Whether a path relative to the root names a file the walk would have
 * collected. The one statement of graph membership: the rules ask it whether the
 * linted file is a subject at all and whether a resolved target is in the model,
 * and the graph cache asks it whether an unstamped file is one the walk should
 * have picked up.
 *
 * Four inline copies of this disjunction is exactly how `isInsideDir` came to
 * exist in three copies sharing one defect - fixing one left the others wrong.
 * Do not reintroduce a local copy.
 */
export function isInGraphScope(relPath, ignoreGlobs) {
    return (!isOutsideRoot(relPath) &&
        !isTestFile(relPath) &&
        !isExcludedPath(relPath, ignoreGlobs));
}
