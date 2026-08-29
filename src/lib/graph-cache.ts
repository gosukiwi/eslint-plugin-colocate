import path from "node:path";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { buildGraphFromFiles, type Graph } from "./graph.js";
import { findTsconfig } from "./resolve.js";
import { isInGraphScope, isSourceFile } from "./scope.js";
import { collectSourceFiles } from "./walk.js";

export type VisitToken = object;

export const REVALIDATE_AFTER_MS = 100;

interface FileStamp {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

interface TsconfigStamp {
  path: string;
  mtimeMs: number;
}

interface Snapshot {
  graph: Graph;
  stamps: Map<string, FileStamp>;
  configs: TsconfigStamp[];
  builtAt: number;
  stampedAt: number;
  coarseTimestamps: boolean;
}

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

function stampFiles(files: readonly string[]): Map<string, FileStamp> {
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

export function stampIsAmbiguous(
  mtimeMs: number,
  builtAt: number,
  coarseTimestamps: boolean,
  stampedAt: number = builtAt,
): boolean {
  if (!coarseTimestamps) {
    return false;
  }
  const buildSecond = Math.floor(builtAt / 1000) * 1000;
  const stampedSecond = Math.floor(stampedAt / 1000) * 1000 + 1000;
  return mtimeMs >= buildSecond && mtimeMs < stampedSecond;
}

function tsconfigNeedsRebuild(snapshot: Snapshot, rootDir: string): boolean {
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
      stampIsAmbiguous(
        stat.mtimeMs,
        snapshot.builtAt,
        snapshot.coarseTimestamps,
        snapshot.stampedAt,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isProductionGraphFile(
  currentFile: string,
  rootDir: string,
  ignoreGlobs: string[],
): boolean {
  const realRoot = safeRealpath(rootDir);
  if (realRoot === undefined || !isSourceFile(currentFile)) {
    return false;
  }
  return isInGraphScope(path.relative(realRoot, currentFile), ignoreGlobs);
}

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

  if (snapshot.stamps.has(currentFile)) {
    return true;
  }
  return !isProductionGraphFile(currentFile, rootDir, ignoreGlobs);
}

function markVisit(
  pass: PassState,
  currentFile: string,
  visitToken: VisitToken | undefined,
): void {
  pass.lastFile = currentFile;
  pass.lastToken =
    visitToken === undefined ? undefined : new WeakRef(visitToken);
}

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

  const builtAt = Date.now();
  const resolvedRoot = safeRealpath(rootDir);
  let graph: Graph;
  let configPaths: string[];
  let stamps: Map<string, FileStamp>;

  if (resolvedRoot === undefined) {
    graph = { importers: new Map(), files: [] };
    configPaths = [];
    stamps = new Map();
  } else {
    const { files, dirStamps } = collectSourceFiles(resolvedRoot, ignoreGlobs);
    stamps = stampFiles(files);
    for (const [dir, stamp] of dirStamps) {
      stamps.set(dir, stamp);
    }
    ({ graph, configPaths } = buildGraphFromFiles(files, resolvedRoot));
  }

  const entry: CacheEntry = {
    snapshot: {
      graph,
      stamps,
      configs: stampConfigs(configPaths),
      builtAt,
      stampedAt: Date.now(),
      coarseTimestamps: hasCoarseTimestamps(stamps),
    },
    pass: {
      visited: new Set([currentFile]),
      lastFile: undefined,
      lastToken: undefined,
      validatedAt: builtAt,
    },
  };
  cache.set(key, entry);
  markVisit(entry.pass, currentFile, visitToken);
  return graph;
}
