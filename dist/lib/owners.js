import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import { derivedFromGraph } from "./derived.js";
import { safeReadFile, safeReaddir, safeRealpath } from "./fs-safe.js";
import { canonicalGraphPath, getGraphResolutionSettings, } from "./graph.js";
import { parseSourceFile } from "./parse.js";
import { isInsideDir } from "./paths.js";
import { resolveSpecifier } from "./resolve.js";
import { SKIP_DIRS } from "./scope.js";
const reExportsByGraph = derivedFromGraph(() => new Map());
function scanReExports(indexFile, dir, graph) {
    const content = safeReadFile(indexFile);
    const realDir = safeRealpath(dir);
    const realIndex = safeRealpath(indexFile);
    if (content === undefined || realDir === undefined) {
        return { local: [], total: 0 };
    }
    const sourceFile = parseSourceFile(indexFile, content);
    const settings = getGraphResolutionSettings(graph);
    const local = new Set();
    const modules = new Set();
    const visit = (node) => {
        if (ts.isExportDeclaration(node) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const resolved = resolveSpecifier(specifier, dir, settings);
            const target = resolved === undefined
                ? undefined
                : canonicalGraphPath(graph, resolved);
            if (target === undefined || target !== realIndex) {
                modules.add(target ?? specifier);
                if (target !== undefined && path.dirname(target) === realDir) {
                    local.add(target);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { local: [...local], total: modules.size };
}
export function collectReExports(indexFile, dir, graph) {
    const key = indexFile + "\0" + dir;
    const perGraph = reExportsByGraph(graph);
    const cached = perGraph.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const result = scanReExports(indexFile, dir, graph);
    perGraph.set(key, result);
    return result;
}
function isNamespaceBarrel(filePath, graph) {
    const basename = path.basename(filePath, path.extname(filePath));
    if (basename !== "index") {
        return false;
    }
    return (collectReExports(filePath, path.dirname(filePath), graph).local.length >= 2);
}
function isOwnerEntryFile(file, dir, graph) {
    if (path.dirname(file) !== dir) {
        return false;
    }
    const base = path.basename(file, path.extname(file));
    if (base === path.basename(dir)) {
        return true;
    }
    if (base !== "index") {
        return false;
    }
    return (graph.importers.get(file) ?? []).some((importer) => path.dirname(importer) !== dir);
}
function directoryHasMatchingEntry(dir, graph) {
    return graph.files.some((file) => isOwnerEntryFile(file, dir, graph));
}
export function getOwner(filePath, graph, rootDir) {
    let dir = path.dirname(filePath);
    const realRoot = safeRealpath(rootDir) ?? rootDir;
    while (true) {
        if (directoryHasMatchingEntry(dir, graph)) {
            return { kind: "folder", path: dir };
        }
        if (dir === realRoot) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return { kind: "standalone", path: filePath };
}
function buildImports(graph) {
    const imports = new Map();
    for (const [target, importers] of graph.importers) {
        for (const importer of importers) {
            const existing = imports.get(importer);
            if (existing === undefined) {
                imports.set(importer, [target]);
            }
            else {
                existing.push(target);
            }
        }
    }
    return imports;
}
function stronglyConnectedIds(nodes, edgesOf) {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const ids = new Map();
    let counter = 0;
    let nextId = 0;
    const push = (node, frames) => {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);
        frames.push({ node, edges: edgesOf(node), next: 0 });
    };
    for (const start of nodes) {
        if (index.has(start)) {
            continue;
        }
        const frames = [];
        push(start, frames);
        while (frames.length > 0) {
            const frame = frames[frames.length - 1];
            if (frame.next < frame.edges.length) {
                const child = frame.edges[frame.next];
                frame.next += 1;
                if (!index.has(child)) {
                    push(child, frames);
                }
                else if (onStack.has(child)) {
                    low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(child) ?? 0));
                }
                continue;
            }
            frames.pop();
            const parent = frames[frames.length - 1];
            if (parent !== undefined) {
                low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
            }
            if (low.get(frame.node) === index.get(frame.node)) {
                const id = nextId;
                nextId += 1;
                while (true) {
                    const member = stack.pop();
                    if (member === undefined) {
                        break;
                    }
                    onStack.delete(member);
                    ids.set(member, id);
                    if (member === frame.node) {
                        break;
                    }
                }
            }
        }
    }
    return ids;
}
function getRoots(graph) {
    const imports = buildImports(graph);
    const componentIds = stronglyConnectedIds(graph.files, (file) => imports.get(file) ?? []);
    const importedFromOutside = new Set();
    for (const file of graph.files) {
        const component = componentIds.get(file);
        for (const importer of graph.importers.get(file) ?? []) {
            if (componentIds.get(importer) !== component && component !== undefined) {
                importedFromOutside.add(component);
            }
        }
    }
    const roots = new Set();
    for (const file of graph.files) {
        const component = componentIds.get(file);
        if (component === undefined || !importedFromOutside.has(component)) {
            roots.add(file);
        }
    }
    return roots;
}
export const getShells = derivedFromGraph((graph) => {
    const roots = getRoots(graph);
    const shells = new Set(roots);
    for (const file of graph.files) {
        if (shells.has(file)) {
            continue;
        }
        const importers = graph.importers.get(file) ?? [];
        if (importers.length > 0 &&
            importers.every((importer) => roots.has(importer))) {
            shells.add(file);
        }
    }
    return shells;
});
export function getColocationConsumers(filePath, graph, shells) {
    const importers = graph.importers.get(filePath) ?? [];
    return importers.filter((importer) => !shells.has(importer) && !isNamespaceBarrel(importer, graph));
}
function collectLayerDirs(dir, cwd, rootDir, layerGlobs, out) {
    for (const entry of safeReaddir(dir)) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        const candidates = [
            path.relative(cwd, fullPath).split(path.sep).join("/"),
            path.relative(rootDir, fullPath).split(path.sep).join("/"),
        ];
        if (layerGlobs.some((glob) => candidates.some((candidate) => minimatch(candidate, glob)))) {
            const realPath = safeRealpath(fullPath);
            if (realPath !== undefined) {
                out.push(realPath);
            }
        }
        collectLayerDirs(fullPath, cwd, rootDir, layerGlobs, out);
    }
}
export function collectLayerDirectories(cwd, layerGlobs, rootDir = cwd) {
    if (layerGlobs.length === 0) {
        return [];
    }
    const dirs = [];
    collectLayerDirs(cwd, cwd, rootDir, layerGlobs, dirs);
    return dirs;
}
const layerDirsByGraph = derivedFromGraph(() => new Map());
export function resolveLayerDirectories(graph, cwd, layerGlobs, rootDir = cwd) {
    if (layerGlobs.length === 0) {
        return [];
    }
    const key = cwd + "\0" + rootDir + "\0" + layerGlobs.join("\0");
    const perGraph = layerDirsByGraph(graph);
    const cached = perGraph.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const dirs = collectLayerDirectories(cwd, layerGlobs, rootDir);
    perGraph.set(key, dirs);
    return dirs;
}
export function isLayerPublicModule(filePath, layerDirs) {
    if (layerDirs.length === 0) {
        return false;
    }
    const parent = path.dirname(filePath);
    if (layerDirs.includes(parent)) {
        return true;
    }
    const grandparent = path.dirname(parent);
    if (!layerDirs.includes(grandparent)) {
        return false;
    }
    const folderName = path.basename(parent);
    const fileBase = path.basename(filePath, path.extname(filePath));
    return fileBase === folderName || fileBase === "index";
}
export function shouldSkipColocation(filePath, ctx) {
    const shells = getShells(ctx.graph);
    if (shells.has(filePath)) {
        return true;
    }
    if (isLayerPublicModule(filePath, ctx.layerDirs)) {
        return true;
    }
    return getColocationConsumers(filePath, ctx.graph, shells).length === 0;
}
function collectConsumerOwners(filePath, ctx) {
    const shells = getShells(ctx.graph);
    const consumers = getColocationConsumers(filePath, ctx.graph, shells);
    const owners = new Map();
    for (const consumer of consumers) {
        const owner = getOwner(consumer, ctx.graph, ctx.rootDir);
        owners.set(owner.path, owner);
    }
    return owners;
}
export function isPrivateOutsideOwner(filePath, ctx) {
    if (shouldSkipColocation(filePath, ctx)) {
        return false;
    }
    const owners = collectConsumerOwners(filePath, ctx);
    if (owners.size !== 1) {
        return false;
    }
    const owner = owners.values().next().value;
    if (owner === undefined) {
        return false;
    }
    if (owner.kind === "folder") {
        return !isInsideDir(filePath, owner.path);
    }
    return filePath !== owner.path;
}
function ownerDir(owner) {
    return owner.kind === "folder" ? owner.path : path.dirname(owner.path);
}
function longestCommonAncestor(dirs) {
    if (dirs.length === 0) {
        return "";
    }
    const segments = dirs.map((dir) => dir.split(path.sep));
    const minLen = Math.min(...segments.map((parts) => parts.length));
    const common = [];
    for (let i = 0; i < minLen; i++) {
        const part = segments[0][i];
        if (segments.every((parts) => parts[i] === part)) {
            common.push(part);
        }
        else {
            break;
        }
    }
    return common.join(path.sep);
}
function folderOwnerAncestors(filePath, graph, rootDir) {
    const realRoot = safeRealpath(rootDir) ?? rootDir;
    const dirs = [];
    let dir = path.dirname(filePath);
    while (true) {
        if (directoryHasMatchingEntry(dir, graph)) {
            dirs.push(dir);
        }
        if (dir === realRoot) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return dirs;
}
export function getSharedColocationIssue(filePath, ctx) {
    if (shouldSkipColocation(filePath, ctx)) {
        return undefined;
    }
    const owners = collectConsumerOwners(filePath, ctx);
    if (owners.size < 2) {
        return undefined;
    }
    const ownerDirs = [...new Set([...owners.values()].map(ownerDir))];
    const lca = longestCommonAncestor(ownerDirs);
    const consumerFolderDirs = [...owners.values()]
        .filter((owner) => owner.kind === "folder")
        .map((owner) => owner.path);
    const candidates = new Set([
        ...consumerFolderDirs,
        ...folderOwnerAncestors(filePath, ctx.graph, ctx.rootDir),
    ]);
    const containing = [...candidates].filter((dir) => {
        if (!isInsideDir(filePath, dir)) {
            return false;
        }
        if (!isInsideDir(dir, lca)) {
            return false;
        }
        return !isOwnerEntryFile(filePath, dir, ctx.graph);
    });
    if (containing.length > 0) {
        return "sharedInsideOwner";
    }
    if (!isInsideDir(filePath, lca)) {
        return "sharedTooHigh";
    }
    return undefined;
}
