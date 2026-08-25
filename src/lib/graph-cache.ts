import path from "node:path";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { buildGraphWithConfigs, type Graph } from "./graph.js";
import { findTsconfig } from "./resolve.js";
import {
  isExcludedPath,
  isOutsideRoot,
  isSourceFile,
  isTestFile,
} from "./scope.js";

// Compared by `===` against a value stored on the graph cache, so it must
// exclude primitives: `unknown` would let a caller pass a string (a filename,
// a config hash) that two unrelated single-file passes could share by
// coincidence, turning "same parse" into a permanent false match instead of
// the intended one-parse window. `object` rules that out under strict mode
// (it also excludes `null`, which `unknown` would otherwise admit).
export type VisitToken = object;

// Upper bound on how long a stale graph can survive a sequence of lints that
// never revisits a file. Well below the time between a human edit and the next
// lint, and far above the gap between two files in one pass. Exported so a test
// asserting behaviour at the boundary sleeps against the real value rather than
// a copy that silently stops matching if this changes.
export const REVALIDATE_AFTER_MS = 100;

interface FileStamp {
  mtimeMs: number;
  // Inode change time, which userland cannot set: it is what catches a
  // replacement that preserved mtime (cp -p, rsync -t, tar -x, a CI cache
  // restore) and happens to keep the same size.
  ctimeMs: number;
  size: number;
}

interface TsconfigStamp {
  path: string;
  mtimeMs: number;
}

/** What the graph was built from - everything staleness is judged against. */
interface Snapshot {
  graph: Graph;
  stamps: Map<string, FileStamp>;
  configs: TsconfigStamp[];
  builtAt: number;
  // Whole-second mtimes mean the filesystem (HFS+, some network mounts) cannot
  // distinguish two writes inside the same second, so a same-size edit would
  // slip past the stamp comparison.
  coarseTimestamps: boolean;
}

/**
 * How often the snapshot gets checked, which is once per lint pass rather than
 * once per linted file - the sweep is O(files) stats, so doing it per file would
 * be O(files^2) per run.
 *
 * `visited` spots the start of a new pass and `validatedAt` covers a pass that
 * never revisits a file. `lastFile`/`lastToken` recognise a *second rule* asking
 * about the same file within one parse, which `visited` alone reads as a new
 * pass: ESLint runs every enabled rule against a file before moving on, so two
 * rules mean two asks per file, and a bare repeat of a file *path* is not
 * evidence either way, because a later pass can legitimately start over on the
 * very file the previous one ended on. Callers pass `context.sourceCode`, which
 * ESLint hands to every rule as the identical object for one parse and a new
 * object for every subsequent parse.
 *
 * Held as a WeakRef, not a strong reference: a SourceCode (source text + full
 * AST) runs roughly 300x the size of the source file, and this entry otherwise
 * outlives the parse - fine for a long-running eslint CLI process where ESLint
 * itself already pins the last SourceCode, but a problem for a host that
 * discards its ESLint instance while the process keeps running (an editor
 * language server). A collected token derefs to undefined, which compares
 * unequal to everything and falls through to the conservative "treat as a new
 * pass" path - safe, just an extra revalidation.
 */
interface PassState {
  visited: Set<string>;
  lastFile: string | undefined;
  lastToken: WeakRef<VisitToken> | undefined;
  validatedAt: number;
}

interface CacheEntry {
  snapshot: Snapshot;
  pass: PassState;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(rootDir: string, ignoreGlobs: string[]): string {
  return rootDir + "\0" + ignoreGlobs.join("\0");
}

function stampFiles(files: string[]): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();
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

function hasCoarseTimestamps(stamps: Map<string, FileStamp>): boolean {
  if (stamps.size === 0) {
    return false;
  }
  return [...stamps.values()].every((stamp) => stamp.mtimeMs % 1000 === 0);
}

function stampConfigs(configPaths: string[]): TsconfigStamp[] {
  const stamps: TsconfigStamp[] = [];
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
export function stampIsAmbiguous(
  mtimeMs: number,
  builtAt: number,
  coarseTimestamps: boolean,
): boolean {
  if (!coarseTimestamps) {
    return false;
  }
  const buildSecond = Math.floor(builtAt / 1000) * 1000;
  return mtimeMs >= buildSecond && mtimeMs < buildSecond + 1000;
}

function tsconfigNeedsRebuild(snapshot: Snapshot, rootDir: string): boolean {
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
function trackedFilesChanged(snapshot: Snapshot): boolean {
  for (const [file, prev] of snapshot.stamps) {
    const stat = safeStat(file);
    if (
      stat === undefined ||
      stat.mtimeMs !== prev.mtimeMs ||
      stat.ctimeMs !== prev.ctimeMs ||
      stat.size !== prev.size
    ) {
      return true;
    }
    if (
      stampIsAmbiguous(stat.mtimeMs, snapshot.builtAt, snapshot.coarseTimestamps)
    ) {
      return true;
    }
  }
  return false;
}

// Mirrors what walkDir would have collected. Anything walkDir skips must be
// skipped here too, or linting one such file rebuilds the whole graph every
// time because its stamp is never recorded.
function isProductionGraphFile(
  currentFile: string,
  rootDir: string,
  ignoreGlobs: string[],
): boolean {
  const realRoot = safeRealpath(rootDir);
  if (realRoot === undefined) {
    return false;
  }

  const relPath = path.relative(realRoot, currentFile);
  if (isOutsideRoot(relPath)) {
    return false;
  }
  if (!isSourceFile(currentFile) || isTestFile(relPath)) {
    return false;
  }
  return !isExcludedPath(relPath, ignoreGlobs);
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
function isSameParse(
  pass: PassState,
  currentFile: string,
  visitToken: VisitToken | undefined,
): boolean {
  return (
    visitToken !== undefined &&
    pass.lastFile === currentFile &&
    pass.lastToken?.deref() === visitToken &&
    Date.now() - pass.validatedAt < REVALIDATE_AFTER_MS
  );
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
function isFresh(
  entry: CacheEntry,
  currentFile: string,
  visitToken: VisitToken | undefined,
  rootDir: string,
  ignoreGlobs: string[],
): boolean {
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
  if (
    pass.visited.has(currentFile) ||
    now - pass.validatedAt >= REVALIDATE_AFTER_MS
  ) {
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
function markVisit(
  pass: PassState,
  currentFile: string,
  visitToken: VisitToken | undefined,
): void {
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
export function getGraph(
  rootDir: string,
  ignoreGlobs: string[],
  currentFile: string,
  visitToken?: VisitToken,
): Graph {
  const key = cacheKey(rootDir, ignoreGlobs);
  const cached = cache.get(key);
  if (
    cached !== undefined &&
    isFresh(cached, currentFile, visitToken, rootDir, ignoreGlobs)
  ) {
    markVisit(cached.pass, currentFile, visitToken);
    return cached.snapshot.graph;
  }

  const { graph, configPaths } = buildGraphWithConfigs(rootDir, ignoreGlobs);
  const stamps = stampFiles(graph.files);
  // One clock read: the build and its first validation are the same event, and
  // two Date.now() calls could straddle a millisecond boundary.
  const now = Date.now();
  const entry: CacheEntry = {
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
