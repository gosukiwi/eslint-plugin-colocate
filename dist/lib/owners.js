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
export function collectReExports(indexFile, dir, graph, rootDir) {
    const content = safeReadFile(indexFile);
    const realDir = safeRealpath(dir);
    const realIndex = safeRealpath(indexFile);
    if (content === undefined || realDir === undefined) {
        return { local: [], total: 0 };
    }
    const sourceFile = parseSourceFile(indexFile, content);
    // Resolving without these silently drops every aliased re-export: the
    // fallback inside resolveSpecifier carries no project `paths` and no
    // baseUrl, so "@/Foo/Bar" named no sibling and one tsconfig alias
    // reclassified the barrel - and with it every finding downstream of
    // getColocationConsumers.
    const settings = getGraphResolutionSettings(graph, rootDir);
    // Keyed by module, not by declaration: the idiomatic value + type split
    // ("export { x } from './X'; export type { T } from './X';") re-exports one
    // sibling and must not look like a two-module namespace barrel.
    const local = new Set();
    // Keyed by resolved module where there is one, and by specifier text only
    // where there is not, so a re-export that does not resolve (a bare package, a
    // types-only module) still marks this index as an aggregator while two
    // spellings of one module count once. Keying on the text alone made "./Bar"
    // plus "./Bar.js" - or, on a case-insensitive disk, "./Bar" plus "./bar" - an
    // aggregator, which suppressed mismatchedEntry just as thoroughly as the
    // double-counted sibling that came with it.
    const modules = new Set();
    const visit = (node) => {
        if (ts.isExportDeclaration(node) &&
            node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            const specifier = node.moduleSpecifier.text;
            const resolved = resolveSpecifier(specifier, dir, settings);
            // resolveSpecifier builds its answer from the specifier's own text and
            // realpath folds neither case nor Unicode normalization, so a target that
            // resolved perfectly well can still be spelled differently from the graph
            // key for the same file. Only the target needs recovering: realDir and
            // realIndex come from a path the walk itself recorded.
            const target = resolved === undefined
                ? undefined
                : canonicalGraphPath(graph, resolved);
            // An index re-exporting itself ("export * from './index'") names no
            // sibling at all.
            if (target === undefined || target !== realIndex) {
                modules.add(target ?? specifier);
                // Asked of the resolved file rather than of the specifier's spelling:
                // a relative-specifier gate here said the same thing for "./Bar" and
                // the wrong thing for an aliased sibling, which stayed uncounted and
                // so unbarrelled.
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
function countLocalReExports(indexFile, dir, graph, rootDir) {
    return collectReExports(indexFile, dir, graph, rootDir).local.length;
}
function isNamespaceBarrel(filePath, graph, rootDir) {
    const basename = path.basename(filePath, path.extname(filePath));
    if (basename !== "index") {
        return false;
    }
    return (countLocalReExports(filePath, path.dirname(filePath), graph, rootDir) >= 2);
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
    // An index makes its directory a module only when the directory is imported
    // through it. A barrel over loose helpers is not a module boundary: counting
    // it as one made a shared helper directory an "owner", which both flagged the
    // files inside it and silenced a standalone owner's private helper.
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
export function getColocationConsumers(filePath, ctx, shells) {
    const importers = ctx.graph.importers.get(filePath) ?? [];
    return importers.filter((importer) => !shells.has(importer) &&
        !isNamespaceBarrel(importer, ctx.graph, ctx.rootDir));
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
//
// Two-level, unlike every other index here: the graph does not determine the
// answer on its own, so the inner map keys the parts that vary per call. Passing
// them to derivedFromGraph as extra arguments would serve one graph's first
// answer to every later cwd and glob set.
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
    // "index" is an entry everywhere else in the plugin, so a layer folder using
    // one was told to move somewhere it cannot go.
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
    return getColocationConsumers(filePath, ctx, shells).length === 0;
}
function collectConsumerOwners(filePath, ctx) {
    const shells = getShells(ctx.graph);
    const consumers = getColocationConsumers(filePath, ctx, shells);
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
        // A folder's own entry is never misplaced within its own folder - there is
        // nowhere else for it to go. If the folder itself sits in the wrong place,
        // the folders above it say so, and they are still in this list.
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
