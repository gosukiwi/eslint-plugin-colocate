import path from "node:path";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
const resolvedLintRoots = new Map();
const fileRealpathsByParse = new WeakMap();
export function resolvedLintRoot(cwd, rootOption) {
    const key = cwd + "\0" + rootOption;
    const cached = resolvedLintRoots.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const rootDir = resolveRootDir(rootOption, cwd);
    const realRootDir = safeRealpath(rootDir);
    if (realRootDir === undefined) {
        return undefined;
    }
    const resolved = { rootDir, realRootDir };
    resolvedLintRoots.set(key, resolved);
    return resolved;
}
export function resolveSubject(context) {
    const options = (context.options[0] ?? {});
    const root = options.root ?? ".";
    const ignore = options.ignore ?? [];
    if (!isSourceFile(context.filename)) {
        return undefined;
    }
    const resolved = resolvedLintRoot(context.cwd, root);
    if (resolved === undefined) {
        return undefined;
    }
    const parse = context.sourceCode;
    let file;
    if (fileRealpathsByParse.has(parse)) {
        file = fileRealpathsByParse.get(parse);
    }
    else {
        file = safeRealpath(context.filename);
        fileRealpathsByParse.set(parse, file);
    }
    if (file === undefined) {
        return undefined;
    }
    const { rootDir, realRootDir } = resolved;
    if (!isInGraphScope(path.relative(realRootDir, file), ignore)) {
        return undefined;
    }
    let graph;
    return {
        rootDir,
        realRootDir,
        file,
        ignore,
        graph: () => (graph ??= getGraph(rootDir, ignore, file, context.sourceCode)),
        covers: (filePath) => isSourceFile(filePath) &&
            isInGraphScope(path.relative(realRootDir, filePath), ignore),
        display: (filePath) => path.relative(realRootDir, filePath).split(path.sep).join("/"),
    };
}
