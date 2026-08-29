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
function foldGraphPath(filePath) {
    const normalized = filePath.normalize("NFC");
    return ts.sys.useCaseSensitiveFileNames
        ? normalized
        : normalized.toLowerCase();
}
const graphFilesByFoldedPath = derivedFromGraph((graph) => new Map(graph.files.map((file) => [foldGraphPath(file), file])));
export function canonicalGraphPath(graph, filePath) {
    if (graphFileSet(graph).has(filePath)) {
        return filePath;
    }
    return graphFilesByFoldedPath(graph).get(foldGraphPath(filePath)) ?? filePath;
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
export function buildGraphWithConfigs(rootDir, ignoreGlobs) {
    const resolvedRoot = safeRealpath(rootDir);
    if (resolvedRoot === undefined) {
        return { graph: { importers: new Map(), files: [] }, configPaths: [] };
    }
    const files = collectSourceFiles(resolvedRoot, ignoreGlobs);
    const fileSet = new Set(files);
    const filesByLowerCase = ts.sys.useCaseSensitiveFileNames
        ? undefined
        : new Map(files.map((file) => [file.toLowerCase(), file]));
    const importers = new Map();
    const settings = createResolutionSettings(resolvedRoot);
    for (const file of files) {
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
            const target = fileSet.has(resolved)
                ? resolved
                : filesByLowerCase?.get(resolved.toLowerCase());
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
    return { graph, configPaths: settings.configPaths };
}
