import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import { safeReadFile, safeReaddir, safeRealpath } from "./fs-safe.js";
import { parseSourceFile, resolveSpecifier, SKIP_DIRS, } from "./graph.js";
const shellsByGraph = new WeakMap();
const layerDirsByGraph = new WeakMap();
export function collectLocalReExports(indexFile, dir) {
    const content = safeReadFile(indexFile);
    const realDir = safeRealpath(dir);
    if (content === undefined || realDir === undefined) {
        return [];
    }
    const sourceFile = parseSourceFile(indexFile, content);
    // Keyed by module, not by declaration: the idiomatic value + type split
    // ("export { x } from './X'; export type { T } from './X';") re-exports one
    // sibling and must not look like a two-module namespace barrel.
    const targets = new Set();
    const visit = (node) => {
        if (ts.isExportDeclaration(node) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            if (specifier.startsWith(".")) {
                const resolved = resolveSpecifier(specifier, dir);
                if (resolved !== undefined && path.dirname(resolved) === realDir) {
                    targets.add(resolved);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...targets];
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
        if (path.dirname(file) !== dir) {
            return false;
        }
        // "index" is an entry everywhere else in the plugin. Requiring the folder's
        // own name here made a folder fronted by index.ts not an owner, so its
        // private helper was reported wherever it sat - including inside the folder,
        // which is the one place the message asks for.
        const base = path.basename(file, path.extname(file));
        return base === dirName || base === "index";
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
    // Entry points are whole components, not individual files. Inside a cycle
    // nothing is importer-free, so asking for zero importers leaves a cyclic
    // entry with no roots at all and strips the shell exemption from the whole
    // project; asking each file individually would promote the inner half of a
    // cycle that something outside imports.
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
// Entry points plus what they import directly. Deliberately not configurable and
// deliberately not transitive: a longer bootstrap chain is expressed by declaring
// the directories it reaches as layers, which states something true about those
// modules. Exempting the shell's imports outright would also hide a shell that
// reaches past a feature's entry into its internals - a real finding.
export function getShells(ctx) {
    const { graph } = ctx;
    const cached = shellsByGraph.get(graph);
    if (cached !== undefined) {
        return cached;
    }
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
    shellsByGraph.set(graph, shells);
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
function collectLayerDirs(dir, cwd, rootDir, layerGlobs, out) {
    for (const entry of safeReaddir(dir)) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        // Matched against both spellings: `ignore` globs are relative to `root`
        // while these were relative to the working directory, so with root: "src"
        // the natural glob silently matched nothing.
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
// Memoised against the graph rather than for the life of the process: a layer
// directory created mid-session used to stay invisible until ESLint restarted,
// which meant a permanent false privateOutsideOwner on every module inside it.
// A new directory rebuilds the graph, which drops this entry with it.
export function resolveLayerDirectories(graph, cwd, layerGlobs, rootDir = cwd) {
    if (layerGlobs.length === 0) {
        return [];
    }
    const key = cwd + "\0" + rootDir + "\0" + layerGlobs.join("\0");
    let perGraph = layerDirsByGraph.get(graph);
    if (perGraph === undefined) {
        perGraph = new Map();
        layerDirsByGraph.set(graph, perGraph);
    }
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
    // "index" is an entry everywhere else in the plugin, so a layer folder using
    // one was told to move somewhere it cannot go.
    return fileBase === folderName || fileBase === "index";
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
    // Only a folder owner has a folder to be inside of; a standalone owner's parent
    // directory belongs to nobody. Every folder owner above the subject counts, not
    // just the innermost one, so a folder entry buried in an unrelated tree is
    // still caught by the tree it is buried in.
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
        // A folder at or above the common ancestor holds every consumer, so being
        // inside it is not "tucked inside one owner".
        if (!isInsideDir(dir, lca)) {
            return false;
        }
        // An owner folder's own entry belongs in its folder - but only when that
        // folder is one of the consumers. Otherwise the folder itself is what sits
        // in the wrong place, and the report still stands.
        return !(isMatchingNameEntry(filePath, dir) && consumerFolderDirs.includes(dir));
    });
    if (containing.length > 0) {
        return "sharedInsideOwner";
    }
    if (!isInsideDir(filePath, lca)) {
        return "sharedTooHigh";
    }
    return undefined;
}
