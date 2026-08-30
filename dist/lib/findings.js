import path from "node:path";
import { derivedFromGraph } from "./derived.js";
import { safeReaddir, safeStat } from "./fs-safe.js";
import { getSharedColocationIssue, isPrivateOutsideOwner, resolveLayerDirectories, } from "./owners.js";
import { isSourceFile, isTestFile, matchesIgnore, SKIP_DIRS, } from "./scope.js";
const singletonStatsByGraph = derivedFromGraph(() => new Map());
const STYLESHEET_EXTS = [".css", ".scss", ".sass", ".less", ".styl"];
function isStylesheet(filePath) {
    const basename = path.basename(filePath);
    return STYLESHEET_EXTS.some((ext) => basename.endsWith(ext));
}
function countSourceFilesRecursive(dir, rootDir, ignore) {
    let sourceCount = 0;
    for (const entry of safeReaddir(dir)) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(rootDir, fullPath);
        if (matchesIgnore(relPath, ignore)) {
            continue;
        }
        const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
        const isDirectory = entry.isSymbolicLink()
            ? (stat?.isDirectory() ?? false)
            : entry.isDirectory();
        if (isDirectory) {
            if (SKIP_DIRS.has(entry.name)) {
                continue;
            }
            sourceCount += countSourceFilesRecursive(fullPath, rootDir, ignore);
            if (sourceCount > 1) {
                return sourceCount;
            }
            continue;
        }
        const isFile = entry.isSymbolicLink()
            ? (stat?.isFile() ?? false)
            : entry.isFile();
        if (!isFile) {
            continue;
        }
        if (isSourceFile(fullPath) && !isTestFile(relPath)) {
            sourceCount += 1;
            if (sourceCount > 1) {
                return sourceCount;
            }
        }
    }
    return sourceCount;
}
export function singletonDirectoryStats(dir, rootDir, ignore, graph) {
    const cache = singletonStatsByGraph(graph);
    const cached = cache.get(dir);
    if (cached !== undefined) {
        return cached;
    }
    const sourceCount = countSourceFilesRecursive(dir, rootDir, ignore);
    const hasStylesheet = sourceCount === 1 && hasCompanionStylesheet(dir);
    const stats = { sourceCount, hasStylesheet };
    cache.set(dir, stats);
    return stats;
}
function hasCompanionStylesheet(dir) {
    return safeReaddir(dir).some((entry) => {
        if (!isStylesheet(entry.name)) {
            return false;
        }
        return entry.isSymbolicLink()
            ? (safeStat(path.join(dir, entry.name))?.isFile() ?? false)
            : entry.isFile();
    });
}
function isSingletonWrapperDirectory(dir, filename, rootDir, ignore, graph) {
    const { sourceCount, hasStylesheet } = singletonDirectoryStats(dir, rootDir, ignore, graph);
    if (sourceCount !== 1 || hasStylesheet) {
        return false;
    }
    const dirName = path.basename(dir);
    const fileBasename = path.basename(filename, path.extname(filename));
    return fileBasename === dirName || fileBasename === "index";
}
export function ownershipFindings(subject, cwd, layers) {
    const { realRootDir: rootDir, file, ignore } = subject;
    const dir = path.dirname(file);
    const graph = subject.graph();
    const ctx = {
        graph,
        rootDir,
        layerDirs: resolveLayerDirectories(graph, cwd, layers, rootDir),
    };
    const findings = [];
    if (dir !== rootDir &&
        isSingletonWrapperDirectory(dir, file, rootDir, ignore, graph)) {
        findings.push("singletonFolder");
    }
    if (isPrivateOutsideOwner(file, ctx)) {
        findings.push("privateOutsideOwner");
    }
    const sharedIssue = getSharedColocationIssue(file, ctx);
    if (sharedIssue !== undefined) {
        findings.push(sharedIssue);
    }
    return findings;
}
