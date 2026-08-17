import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import { safeReadFile, safeReaddir, safeRealpath } from "./fs-safe.js";
import { matchesIgnore, parseSourceFile, resolveSpecifier, SKIP_DIRS, } from "./graph.js";
const shellsByGraph = new WeakMap();
const layerDirsCache = new Map();
export function collectLocalReExports(indexFile, dir) {
    const content = safeReadFile(indexFile);
    const realDir = safeRealpath(dir);
    if (content === undefined || realDir === undefined) {
        return [];
    }
    const sourceFile = parseSourceFile(indexFile, content);
    const targets = [];
    const visit = (node) => {
        if (ts.isExportDeclaration(node) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            if (specifier.startsWith(".")) {
                const resolved = resolveSpecifier(specifier, dir);
                if (resolved !== undefined && path.dirname(resolved) === realDir) {
                    targets.push(resolved);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return targets;
}
export function countLocalReExports(indexFile, dir) {
    return collectLocalReExports(indexFile, dir).length;
}
function isNamespaceBarrel(filePath) {
    const basename = path.basename(filePath, path.extname(filePath));
    if (basename !== "index") {
        return false;
    }
    return countLocalReExports(filePath, path.dirname(filePath)) >= 2;
}
function directoryHasMatchingEntry(dir, graph) {
    const dirName = path.basename(dir);
    return graph.files.some((file) => {
        return (path.dirname(file) === dir &&
            path.basename(file, path.extname(file)) === dirName);
    });
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
// Tarjan, iterative so a deep import chain cannot blow the stack.
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
    const roots = new Set();
    for (const file of graph.files) {
        const importers = graph.importers.get(file) ?? [];
        // No importers at all is the common case. A file whose only importers sit
        // in its own cycle also counts: inside a cycle nothing is importer-free, so
        // requiring that would leave a cyclic entry point with no roots and strip
        // the shell exemption from the whole project.
        const importedFromOutside = importers.some((importer) => componentIds.get(importer) !== componentIds.get(file));
        if (!importedFromOutside) {
            roots.add(file);
        }
    }
    return roots;
}
export function getShells(ctx) {
    const { graph, rootDir, shellGlobs } = ctx;
    const key = rootDir + "\0" + shellGlobs.join("\0");
    const cached = shellsByGraph.get(graph);
    if (cached !== undefined && cached.key === key) {
        return cached.shells;
    }
    const roots = getRoots(graph);
    const shells = new Set(roots);
    for (const file of graph.files) {
        if (shells.has(file)) {
            continue;
        }
        if (matchesIgnore(path.relative(rootDir, file), shellGlobs)) {
            shells.add(file);
            continue;
        }
        const importers = graph.importers.get(file) ?? [];
        if (importers.length > 0 &&
            importers.every((importer) => roots.has(importer))) {
            shells.add(file);
        }
    }
    shellsByGraph.set(graph, { key, shells });
    return shells;
}
export function getColocationConsumers(filePath, graph, shells) {
    const importers = graph.importers.get(filePath) ?? [];
    return importers.filter((importer) => !shells.has(importer) && !isNamespaceBarrel(importer));
}
function isInsideDir(filePath, dir) {
    return filePath.startsWith(dir + path.sep);
}
function isMatchingNameEntry(filePath, ownerDir) {
    return (path.dirname(filePath) === ownerDir &&
        path.basename(filePath, path.extname(filePath)) === path.basename(ownerDir));
}
function collectLayerDirs(dir, cwd, layerGlobs, out) {
    for (const entry of safeReaddir(dir)) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(cwd, fullPath).split(path.sep).join("/");
        if (layerGlobs.some((glob) => minimatch(relPath, glob))) {
            const realPath = safeRealpath(fullPath);
            if (realPath !== undefined) {
                out.push(realPath);
            }
        }
        collectLayerDirs(fullPath, cwd, layerGlobs, out);
    }
}
export function resolveLayerDirectories(cwd, layerGlobs) {
    if (layerGlobs.length === 0)
        return [];
    const key = cwd + "\0" + layerGlobs.join("\0");
    const cached = layerDirsCache.get(key);
    if (cached !== undefined)
        return cached;
    const dirs = [];
    collectLayerDirs(cwd, cwd, layerGlobs, dirs);
    layerDirsCache.set(key, dirs);
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
    return fileBase === folderName;
}
export function shouldSkipColocation(filePath, ctx) {
    const shells = getShells(ctx);
    if (shells.has(filePath)) {
        return true;
    }
    if (isLayerPublicModule(filePath, ctx.layerDirs)) {
        return true;
    }
    return getColocationConsumers(filePath, ctx.graph, shells).length === 0;
}
function collectConsumerOwners(filePath, ctx) {
    const shells = getShells(ctx);
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
        if (isMatchingNameEntry(filePath, owner.path)) {
            return false;
        }
        return !isInsideDir(filePath, owner.path);
    }
    return filePath !== owner.path;
}
function ownerDir(owner) {
    return owner.kind === "folder" ? owner.path : path.dirname(owner.path);
}
function longestCommonAncestor(dirs) {
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
    if (common.length === 0) {
        return path.sep;
    }
    return common.join(path.sep);
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
    const containing = ownerDirs.filter((dir) => isInsideDir(filePath, dir));
    if (containing.length > 0) {
        const longestLen = Math.max(...containing.map((dir) => dir.length));
        const innermost = containing.filter((dir) => dir.length === longestLen);
        if (innermost.length === 1 && innermost[0] !== lca) {
            return "sharedInsideOwner";
        }
    }
    if (filePath !== lca && !isInsideDir(filePath, lca)) {
        return "sharedTooHigh";
    }
    return undefined;
}
