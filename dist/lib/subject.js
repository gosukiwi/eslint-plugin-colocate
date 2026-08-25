import path from "node:path";
import { safeRealpath } from "./fs-safe.js";
import { getGraph } from "./graph-cache.js";
import { resolveRootDir } from "./root.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
/**
 * `undefined` when there is nothing to say about this file: a root that is not
 * on disk, a linted path that is not a real file (processors,
 * `--stdin-filename`, a file deleted mid-run), or a file outside the model.
 * Tolerant rather than throwing, since none of those is the user's mistake.
 */
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
    // Deliberate asymmetry: resolved targets are extension-tested by `covers`,
    // but the linted file is only scope-tested here - the extension check already
    // happened on the path ESLint handed over, so a `.ts` symlink pointing at a
    // `.txt` file is still a subject.
    if (!isInGraphScope(path.relative(realRootDir, file), ignore)) {
        return undefined;
    }
    let graph;
    return {
        rootDir,
        realRootDir,
        file,
        lintedPath: context.filename,
        ignore,
        graph: () => (graph ??= getGraph(rootDir, ignore, file, context.sourceCode)),
        covers: (filePath) => isSourceFile(filePath) &&
            isInGraphScope(path.relative(realRootDir, filePath), ignore),
        display: (filePath) => path.relative(realRootDir, filePath).split(path.sep).join("/"),
    };
}
