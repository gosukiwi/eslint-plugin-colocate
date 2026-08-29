import path from "node:path";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { buildGraphFromFiles } from "./graph.js";
import { findTsconfig } from "./resolve.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
import { collectSourceFiles } from "./walk.js";
export const REVALIDATE_AFTER_MS = 100;
let cache;
function cacheKey(rootDir, ignoreGlobs) {
    return rootDir + "\0" + ignoreGlobs.join("\0");
}
function stampFiles(files) {
    const stamps = new Map();
    for (const file of files) {
        const stat = safeStat(file);
        if (stat !== undefined) {
            stamps.set(file, {
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                size: stat.size,
            });
        }
    }
    return stamps;
}
function hasCoarseTimestamps(stamps) {
    if (stamps.size === 0) {
        return false;
    }
    return [...stamps.values()].every((stamp) => stamp.mtimeMs % 1000 === 0);
}
function stampConfigs(configPaths) {
    const stamps = [];
    for (const configPath of configPaths) {
        const stat = safeStat(configPath);
        stamps.push({ path: configPath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
    return stamps;
}
export function stampIsAmbiguous(mtimeMs, builtAt, coarseTimestamps, stampedAt) {
    if (!coarseTimestamps) {
        return false;
    }
    const buildSecond = Math.floor(builtAt / 1000) * 1000;
    const stampedSecond = Math.floor(stampedAt / 1000) * 1000 + 1000;
    return mtimeMs >= buildSecond && mtimeMs < stampedSecond;
}
function tsconfigNeedsRebuild(snapshot, rootDir) {
    const currentPath = findTsconfig(safeRealpath(rootDir) ?? rootDir);
    const previousPath = snapshot.configs[0]?.path;
    if (currentPath !== previousPath) {
        return true;
    }
    return snapshot.configs.some((stamp) => {
        const stat = safeStat(stamp.path);
        return (stat?.mtimeMs ?? 0) !== stamp.mtimeMs;
    });
}
function trackedFilesChanged(snapshot) {
    for (const [file, prev] of snapshot.stamps) {
        const stat = safeStat(file);
        if (stat === undefined ||
            stat.mtimeMs !== prev.mtimeMs ||
            stat.ctimeMs !== prev.ctimeMs ||
            stat.size !== prev.size) {
            return true;
        }
        if (stampIsAmbiguous(stat.mtimeMs, snapshot.builtAt, snapshot.coarseTimestamps, snapshot.stampedAt)) {
            return true;
        }
    }
    return false;
}
function isProductionGraphFile(currentFile, rootDir, ignoreGlobs) {
    const realRoot = safeRealpath(rootDir);
    if (realRoot === undefined || !isSourceFile(currentFile)) {
        return false;
    }
    return isInGraphScope(path.relative(realRoot, currentFile), ignoreGlobs);
}
function isSameVisit(pass, currentFile, visitToken) {
    return (visitToken !== undefined &&
        pass.lastFile === currentFile &&
        pass.lastToken?.deref() === visitToken);
}
function isFresh(entry, currentFile, visitToken, rootDir, ignoreGlobs) {
    const { snapshot, pass } = entry;
    const now = Date.now();
    const sameVisit = isSameVisit(pass, currentFile, visitToken);
    const idle = now - pass.lastVisitAt >= REVALIDATE_AFTER_MS;
    if (sameVisit && !idle) {
        return true;
    }
    if (tsconfigNeedsRebuild(snapshot, rootDir)) {
        return false;
    }
    const newPass = !sameVisit && (pass.visited.has(currentFile) || idle);
    if (newPass) {
        pass.visited.clear();
    }
    if ((newPass || sameVisit) && trackedFilesChanged(snapshot)) {
        return false;
    }
    pass.lastVisitAt = Date.now();
    pass.visited.add(currentFile);
    if (snapshot.stamps.has(currentFile)) {
        return true;
    }
    return !isProductionGraphFile(currentFile, rootDir, ignoreGlobs);
}
function markVisit(pass, currentFile, visitToken) {
    pass.lastFile = currentFile;
    pass.lastToken =
        visitToken === undefined ? undefined : new WeakRef(visitToken);
}
export function getGraph(rootDir, ignoreGlobs, currentFile, visitToken) {
    const key = cacheKey(rootDir, ignoreGlobs);
    if (cache !== undefined &&
        cache.key === key &&
        isFresh(cache.entry, currentFile, visitToken, rootDir, ignoreGlobs)) {
        markVisit(cache.entry.pass, currentFile, visitToken);
        return cache.entry.snapshot.graph;
    }
    const builtAt = Date.now();
    const resolvedRoot = safeRealpath(rootDir);
    let graph;
    let configPaths;
    let stamps;
    if (resolvedRoot === undefined) {
        graph = { importers: new Map(), files: [] };
        configPaths = [];
        stamps = new Map();
    }
    else {
        const { files, dirStamps } = collectSourceFiles(resolvedRoot, ignoreGlobs);
        stamps = stampFiles(files);
        for (const [dir, stamp] of dirStamps) {
            stamps.set(dir, stamp);
        }
        ({ graph, configPaths } = buildGraphFromFiles(files, resolvedRoot));
    }
    const stampedAt = Date.now();
    const entry = {
        snapshot: {
            graph,
            stamps,
            configs: stampConfigs(configPaths),
            builtAt,
            stampedAt,
            coarseTimestamps: hasCoarseTimestamps(stamps),
        },
        pass: {
            visited: new Set([currentFile]),
            lastFile: undefined,
            lastToken: undefined,
            lastVisitAt: stampedAt,
        },
    };
    cache = { key, entry };
    markVisit(entry.pass, currentFile, visitToken);
    return graph;
}
