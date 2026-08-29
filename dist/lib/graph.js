import path from "node:path";
import ts from "typescript";
import { derivedFromGraph } from "./derived.js";
import { safeReadFile, safeRealpath } from "./fs-safe.js";
import { extractSpecifiers } from "./parse.js";
import { createResolutionSettings, resolveSpecifier } from "./resolve.js";
import { collectSourceFiles } from "./walk.js";
const graphFileSet = derivedFromGraph((graph) => new Set(graph.files));
export function graphHasFile(graph, filePath) {
    return graphFileSet(graph).has(filePath);
}
function filesByParentDir(files) {
    const byDir = new Map();
    for (const file of files) {
        const dir = path.dirname(file);
        const list = byDir.get(dir);
        if (list === undefined) {
            byDir.set(dir, [file]);
        }
        else {
            list.push(file);
        }
    }
    return byDir;
}
const graphFilesByDir = derivedFromGraph((graph) => filesByParentDir(graph.files));
export function graphFilesInDir(graph, dir) {
    return graphFilesByDir(graph).get(dir) ?? [];
}
function foldGraphPath(filePath) {
    const normalized = filePath.normalize("NFC");
    return ts.sys.useCaseSensitiveFileNames
        ? normalized
        : normalized.toLowerCase();
}
const graphFilesByFoldedPath = derivedFromGraph((graph) => new Map(graph.files.map((file) => [foldGraphPath(file), file])));
function graphFileForPath(fileSet, filesByFoldedPath, filePath) {
    if (fileSet.has(filePath)) {
        return filePath;
    }
    return filesByFoldedPath.get(foldGraphPath(filePath));
}
export function canonicalGraphPath(graph, filePath) {
    return (graphFileForPath(graphFileSet(graph), graphFilesByFoldedPath(graph), filePath) ?? filePath);
}
function noProjectResolutionSettings() {
    const resolutionOptions = {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowJs: true,
    };
    return {
        options: resolutionOptions,
        cache: ts.createModuleResolutionCache("/", (fileName) => fileName, resolutionOptions),
        configPaths: [],
    };
}
export const getGraphResolutionSettings = derivedFromGraph((_graph) => noProjectResolutionSettings());
export function buildGraph(rootDir, ignoreGlobs) {
    return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}
export function buildGraphFromFiles(files, resolvedRoot) {
    const fileSet = new Set(files);
    const filesByFoldedPath = new Map(files.map((file) => [foldGraphPath(file), file]));
    const importers = new Map();
    const settings = createResolutionSettings(resolvedRoot);
    for (const file of files) {
        const realFile = safeRealpath(file);
        if (realFile !== undefined && realFile !== file) {
            continue;
        }
        const content = safeReadFile(file);
        if (content === undefined) {
            continue;
        }
        const fromDir = path.dirname(file);
        for (const specifier of extractSpecifiers(content, file)) {
            const resolved = resolveSpecifier(specifier, fromDir, settings);
            if (resolved === undefined) {
                continue;
            }
            const target = graphFileForPath(fileSet, filesByFoldedPath, resolved);
            if (target === undefined || target === file) {
                continue;
            }
            const existing = importers.get(target);
            if (existing === undefined) {
                importers.set(target, [file]);
            }
            else if (!existing.includes(file)) {
                existing.push(file);
            }
        }
    }
    const graph = { importers, files };
    getGraphResolutionSettings.prime(graph, settings);
    graphFileSet.prime(graph, fileSet);
    graphFilesByFoldedPath.prime(graph, filesByFoldedPath);
    graphFilesByDir.prime(graph, filesByParentDir(files));
    return { graph, configPaths: settings.configPaths };
}
export function buildGraphWithConfigs(rootDir, ignoreGlobs) {
    const resolvedRoot = safeRealpath(rootDir);
    if (resolvedRoot === undefined) {
        return { graph: { importers: new Map(), files: [] }, configPaths: [] };
    }
    const { files } = collectSourceFiles(resolvedRoot, ignoreGlobs);
    const { graph, configPaths } = buildGraphFromFiles(files, resolvedRoot);
    return { graph, configPaths };
}
