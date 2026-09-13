import path from "node:path";
import { classifyDirEntry, safeReaddir, safeRealpath, safeStat, } from "./fs-safe.js";
import { isAtOrInsideDir } from "./paths.js";
import { isExcludedPath, isSourceFile, isTestFile, matchesIgnore, SKIP_DIRS, } from "./scope.js";
function stampDir(dir, dirStamps) {
    const stat = safeStat(dir);
    if (stat !== undefined) {
        dirStamps.set(dir, {
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            size: stat.size,
        });
    }
}
function resolveWalkRealPath(fullPath, followLink, rootDir, ignoreGlobs) {
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
function visitDirectory(fullPath, realPath, isLink, ctx, nested) {
    if (isLink) {
        if (ctx.linkedRealDirs.has(realPath)) {
            return;
        }
        ctx.linkedRealDirs.add(realPath);
    }
    walkDir(fullPath, ctx.rootDir, ctx.ignoreGlobs, ctx.files, ctx.dirStamps, nested, ctx.linkedRealDirs, ctx.behindLink || isLink);
}
function collectFileEntry(fullPath, realPath, relPath, isLink, files) {
    if (!isSourceFile(fullPath) || isTestFile(relPath)) {
        return;
    }
    files.add(realPath);
    if (isLink && fullPath !== realPath) {
        files.add(fullPath);
    }
}
function visitEntry(entry, dir, ctx, nested) {
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
    const realPath = resolveWalkRealPath(fullPath, isLink || ctx.behindLink, ctx.rootDir, ctx.ignoreGlobs);
    if (realPath === undefined) {
        return;
    }
    if (kind === "directory") {
        visitDirectory(fullPath, realPath, isLink, ctx, nested);
        return;
    }
    collectFileEntry(fullPath, realPath, relPath, isLink, ctx.files);
}
function walkDir(dir, rootDir, ignoreGlobs, files, dirStamps, ancestorRealDirs, linkedRealDirs, behindLink) {
    const realDir = safeRealpath(dir);
    if (realDir === undefined || ancestorRealDirs.has(realDir)) {
        return;
    }
    stampDir(dir, dirStamps);
    const nested = new Set(ancestorRealDirs).add(realDir);
    const ctx = {
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
export function collectSourceFiles(resolvedRoot, ignoreGlobs) {
    const collected = new Set();
    const dirStamps = new Map();
    walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, collected, dirStamps, new Set(), new Set(), false);
    return {
        files: [...collected].sort(),
        dirStamps,
    };
}
