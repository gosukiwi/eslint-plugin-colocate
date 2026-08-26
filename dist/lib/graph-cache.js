import path from "node:path";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { buildGraphWithConfigs } from "./graph.js";
import { findTsconfig } from "./resolve.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
// Upper bound on how long a stale graph can survive a sequence of lints that
// never revisits a file. Well below the time between a human edit and the next
// lint, and far above the gap between two files in one pass. Exported so a test
// asserting behaviour at the boundary sleeps against the real value rather than
// a copy that silently stops matching if this changes.
export const REVALIDATE_AFTER_MS = 100;
const cache = new Map();
function cacheKey(rootDir, ignoreGlobs) {
    return rootDir + "\0" + ignoreGlobs.join("\0");
}
function stampFiles(files) {
    const stamps = new Map();
    for (const file of files) {
        const stat = safeStat(file);
        if (stat !== undefined) {
            stamps.set(file, {
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                size: stat.size,
            });
        }
    }
    return stamps;
}
function hasCoarseTimestamps(stamps) {
    if (stamps.size === 0) {
        return false;
    }
    return [...stamps.values()].every((stamp) => stamp.mtimeMs % 1000 === 0);
}
function stampConfigs(configPaths) {
    const stamps = [];
    for (const configPath of configPaths) {
        const stat = safeStat(configPath);
        stamps.push({ path: configPath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
    return stamps;
}
// On a filesystem that reports whole-second timestamps, a write landing in the
// same second as the build is indistinguishable from one that preceded it, so
// such a stamp cannot be trusted. Comparing against the build time rather than
// against "now" is what makes this exact: keying off the age of the mtime gave a
// window that shrank to nothing for a write late in a second.
export function stampIsAmbiguous(mtimeMs, builtAt, coarseTimestamps) {
    if (!coarseTimestamps) {
        return false;
    }
    const buildSecond = Math.floor(builtAt / 1000) * 1000;
    return mtimeMs >= buildSecond && mtimeMs < buildSecond + 1000;
}
function tsconfigNeedsRebuild(snapshot, rootDir) {
    // Resolved first: the stored path came from the resolved root, so comparing a
    // raw symlinked root found a different config every time and rebuilt the
    // whole graph on every lint.
    const currentPath = findTsconfig(safeRealpath(rootDir) ?? rootDir);
    const previousPath = snapshot.configs[0]?.path;
    if (currentPath !== previousPath) {
        return true;
    }
    return snapshot.configs.some((stamp) => {
        const stat = safeStat(stamp.path);
        return (stat?.mtimeMs ?? 0) !== stamp.mtimeMs;
    });
}
// Every tracked file, not only the one being linted. ESLint lints one file at a
// time, so checking just that file left an edit to any other file invisible: the
// report neither appeared nor - worse - went away once the user fixed the import
// in the file that caused it. Deletions were never noticed at all.
function trackedFilesChanged(snapshot) {
    for (const [file, prev] of snapshot.stamps) {
        const stat = safeStat(file);
        if (stat === undefined ||
            stat.mtimeMs !== prev.mtimeMs ||
            stat.ctimeMs !== prev.ctimeMs ||
            stat.size !== prev.size) {
            return true;
        }
        if (stampIsAmbiguous(stat.mtimeMs, snapshot.builtAt, snapshot.coarseTimestamps)) {
            return true;
        }
    }
    return false;
}
// Mirrors what walkDir would have collected, via the one statement of graph
// membership in scope.ts. Anything walkDir skips must be skipped here too, or
// linting one such file rebuilds the whole graph every time because its stamp is
// never recorded.
function isProductionGraphFile(currentFile, rootDir, ignoreGlobs) {
    const realRoot = safeRealpath(rootDir);
    if (realRoot === undefined || !isSourceFile(currentFile)) {
        return false;
    }
    return isInGraphScope(path.relative(realRoot, currentFile), ignoreGlobs);
}
// Recognises a second rule asking about the same parse. Bounded by
// REVALIDATE_AFTER_MS because token identity proves "same SourceCode object",
// not "same moment": Linter#verify accepts a SourceCode instance and passes its
// identity straight through to context.sourceCode, so a host that retains one
// and re-verifies it keeps the token alive indefinitely. Unbounded, that froze
// the graph permanently - every later verify matched the token, so neither the
// tsconfig check nor the tracked-file sweep ever ran again, and a report could
// not be made to go away by editing any file other than the one being linted.
// The bound costs nothing inside a real parse (two rules are microseconds apart)
// and puts the worst case back on the same footing as every other staleness
// window here.
function isSameParse(pass, currentFile, visitToken) {
    return (visitToken !== undefined &&
        pass.lastFile === currentFile &&
        pass.lastToken?.deref() === visitToken &&
        Date.now() - pass.validatedAt < REVALIDATE_AFTER_MS);
}
/**
 * Whether the cached graph can be handed back as-is.
 *
 * Order matters. A second rule's call inside the very same parse cannot have
 * observed a tsconfig edit or a tracked-file change that the first rule's call
 * did not already validate, so `isSameParse` comes first and skips both sweeps
 * entirely - `tsconfigNeedsRebuild`'s realpath + findTsconfig walk + config
 * stats, and the once-per-pass stamp sweep with its own realpath - rather than
 * merely avoiding the pass-boundary bookkeeping.
 */
function isFresh(entry, currentFile, visitToken, rootDir, ignoreGlobs) {
    const { snapshot, pass } = entry;
    if (isSameParse(pass, currentFile, visitToken)) {
        return true;
    }
    if (tsconfigNeedsRebuild(snapshot, rootDir)) {
        return false;
    }
    // Validate the tracked set once per pass: seeing a file again means a new pass
    // began, and the elapsed-time bound covers passes that never revisit a file.
    // Any repeat of currentFile that reaches here is a genuine new pass, because
    // isSameParse already absorbed a second rule re-checking the same file.
    const now = Date.now();
    if (pass.visited.has(currentFile) ||
        now - pass.validatedAt >= REVALIDATE_AFTER_MS) {
        pass.visited.clear();
        pass.validatedAt = now;
        if (trackedFilesChanged(snapshot)) {
            return false;
        }
    }
    pass.visited.add(currentFile);
    // No stamp means the file was created since the build, so the graph does not
    // know about it yet.
    if (snapshot.stamps.has(currentFile)) {
        return true;
    }
    return !isProductionGraphFile(currentFile, rootDir, ignoreGlobs);
}
// One step, because the pair is meaningless apart: a lastFile without its
// lastToken (or vice versa) is a same-parse hit waiting to be claimed by the
// wrong caller.
function markVisit(pass, currentFile, visitToken) {
    pass.lastFile = currentFile;
    pass.lastToken =
        visitToken === undefined ? undefined : new WeakRef(visitToken);
}
/**
 * The graph for `rootDir`, built once per process and revalidated once per lint
 * pass.
 *
 * `visitToken` should be `context.sourceCode`: ESLint hands every rule the
 * identical object for one parse of a file and a new object for every subsequent
 * parse, so it is what lets a second rule asking about the same file skip
 * revalidation entirely rather than merely avoid tripping the pass-boundary
 * check (see runRules in ESLint's linter, which builds one shared rule-context
 * base per file and extends it per rule; verified this holds across ESLint 9 and
 * 10, under `--cache`, `lintText`, and a processor splitting one file into
 * several blocks). Omitting it - a direct call from a test, a single-rule setup
 * that only ever asks once per file - keeps the original, more conservative
 * behaviour, where every repeat of a file counts as a new pass.
 */
export function getGraph(rootDir, ignoreGlobs, currentFile, visitToken) {
    const key = cacheKey(rootDir, ignoreGlobs);
    const cached = cache.get(key);
    if (cached !== undefined &&
        isFresh(cached, currentFile, visitToken, rootDir, ignoreGlobs)) {
        markVisit(cached.pass, currentFile, visitToken);
        return cached.snapshot.graph;
    }
    const { graph, configPaths } = buildGraphWithConfigs(rootDir, ignoreGlobs);
    const stamps = stampFiles(graph.files);
    // One clock read: the build and its first validation are the same event, and
    // two Date.now() calls could straddle a millisecond boundary.
    const now = Date.now();
    const entry = {
        snapshot: {
            graph,
            stamps,
            configs: stampConfigs(configPaths),
            builtAt: now,
            coarseTimestamps: hasCoarseTimestamps(stamps),
        },
        pass: {
            visited: new Set([currentFile]),
            lastFile: undefined,
            lastToken: undefined,
            validatedAt: now,
        },
    };
    cache.set(key, entry);
    markVisit(entry.pass, currentFile, visitToken);
    return graph;
}
