import path from "node:path";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
export function resolveSubject(context) {
    const options = (context.options[0] ?? {});
    const ignore = options.ignore ?? [];
    if (!isSourceFile(context.filename)) {
        return undefined;
    }
    const rootDir = resolveRootDir(options.root ?? ".", context.cwd);
    const realRootDir = safeRealpath(rootDir);
    const file = safeRealpath(context.filename);
    if (realRootDir === undefined || file === undefined) {
        return undefined;
    }
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
