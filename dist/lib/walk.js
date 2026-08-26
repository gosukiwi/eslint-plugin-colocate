import path from "node:path";
import { safeReaddir, safeRealpath, safeStat } from "./fs-safe.js";
import { isAtOrInsideDir } from "./paths.js";
import { isExcludedPath, isSourceFile, isTestFile, matchesIgnore, SKIP_DIRS, } from "./scope.js";
function walkDir(dir, rootDir, ignoreGlobs, files, ancestorRealDirs, linkedRealDirs, behindLink) {
    const realDir = safeRealpath(dir);
    // Guarded per branch rather than globally: two sibling links to one real
    // directory are both legitimate, and a global set let whichever path was
    // walked first decide the other's fate - so an ignore glob aimed at a link
    // erased the real directory too.
    if (realDir === undefined || ancestorRealDirs.has(realDir)) {
        return;
    }
    const nested = new Set(ancestorRealDirs).add(realDir);
    for (const entry of safeReaddir(dir)) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(rootDir, fullPath);
        // readdir reports a symlink as neither file nor directory, so entries were
        // dropped here while the resolver followed them happily - a module behind a
        // linked directory was invisible as a consumer. Stat follows the link.
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
        // Only links (and anything below one) need resolving; on a tree with no
        // symlinks fullPath is already canonical, because the walk started from the
        // resolved root.
        const isLink = entry.isSymbolicLink();
        const realPath = isLink || behindLink ? safeRealpath(fullPath) : fullPath;
        if (realPath === undefined) {
            continue;
        }
        // Links are checked under the path they really point at as well. Anything
        // resolving outside the root stays out of the graph: such files cannot be
        // reported (they are outside root) yet would still act as importers and as
        // owners, which turned a linked-in directory into a phantom second owner and
        // a symlinked entry file into a directory that no longer had an entry.
        // Ignoring a directory also cannot be undone by reaching it through a link.
        if (realPath !== fullPath) {
            if (!isAtOrInsideDir(realPath, rootDir)) {
                continue;
            }
            if (isExcludedPath(path.relative(rootDir, realPath), ignoreGlobs)) {
                continue;
            }
        }
        if (isDirectory) {
            // Sibling links to one real directory are both legitimate, but nesting
            // them makes the walk exponential (2^depth), so each real directory is
            // entered through a link at most once. Directories reached without a link
            // are always walked.
            if (isLink) {
                if (linkedRealDirs.has(realPath)) {
                    continue;
                }
                linkedRealDirs.add(realPath);
            }
            walkDir(fullPath, rootDir, ignoreGlobs, files, nested, linkedRealDirs, behindLink || isLink);
            continue;
        }
        if (isSourceFile(fullPath) && !isTestFile(relPath)) {
            // A Set because following symlinks can reach the same real file twice.
            files.add(realPath);
        }
    }
}
/** Every source file under a resolved root, sorted, in the walk's own spelling. */
export function collectSourceFiles(resolvedRoot, ignoreGlobs) {
    const collected = new Set();
    walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, collected, new Set(), new Set(), false);
    return [...collected].sort();
}
