import path from "node:path";
import ts from "typescript";
import { derivedFromGraph } from "./derived.js";
import { safeReadFile, safeRealpath } from "./fs-safe.js";
import { extractSpecifiers } from "./parse.js";
import { createResolutionSettings, resolveSpecifier } from "./resolve.js";
import { collectSourceFiles } from "./walk.js";

/**
 * Readonly because six indexes are derived from a graph and memoised against
 * the graph object for its whole lifetime (see derived.ts): mutating `files` or
 * `importers` in place would silently desync every one of them. A changed tree
 * produces a NEW graph - which is also what drops the old indexes, since
 * nothing invalidates them.
 */
export interface Graph {
  readonly importers: ReadonlyMap<string, readonly string[]>;
  readonly files: readonly string[];
}

// Exact graph membership. Only needed to give an exact hit precedence over the
// fold below, which is why it is not part of Graph itself.
const graphFileSet = derivedFromGraph((graph) => new Set(graph.files));

// The two axes on which a resolved path can disagree with the graph's own
// spelling while still naming the same file on disk:
//
// - Unicode normalization, always. `readdir` reports whatever form the
//   filesystem stores, while a specifier carries whatever form the author's
//   editor wrote, and `realpath` preserves it rather than converting. macOS
//   happily opens either, so "Café/inner.ts" written NFD resolves to a real
//   file whose graph key is NFC - different bytes, same file. This is not
//   case-sensitivity-dependent, so it is folded on every platform.
// - Case, only where the filesystem ignores it. Folding case on a
//   case-sensitive volume would merge two genuinely distinct files.
function foldGraphPath(filePath: string): string {
  const normalized = filePath.normalize("NFC");
  return ts.sys.useCaseSensitiveFileNames
    ? normalized
    : normalized.toLowerCase();
}

// Graph files indexed by their folded key (see foldGraphPath), for recovering
// the graph's own spelling of a path that points at the same file by a different
// one. Built on demand rather than primed by buildGraphWithConfigs: the map that
// function builds for edge recovery is keyed on lower case alone, which is a
// different key from this one, so the two cannot be shared.
const graphFilesByFoldedPath = derivedFromGraph(
  (graph) => new Map(graph.files.map((file) => [foldGraphPath(file), file])),
);

/**
 * The graph's own spelling of a resolved path, or the path unchanged when
 * nothing in the graph matches it.
 *
 * `resolveSpecifier` hands back a path built from the specifier's own text, and
 * `fs.realpathSync` (what `safeRealpath` uses) neither folds case on macOS - only
 * its `.native` variant does - nor normalizes Unicode on any platform. So a path
 * that resolved perfectly well can still differ byte-for-byte from the one the
 * walk recorded. Callers that key off a file's directory (gates) need the
 * recorded spelling or they miss real boundaries and invent fake ones.
 */
export function canonicalGraphPath(graph: Graph, filePath: string): string {
  // An exact member of graph.files is already in the graph's spelling, so
  // folding it would be a rewrite rather than a recovery - the same precedence
  // buildGraphWithConfigs applies to resolveSpecifier's result. Two files can
  // share one folded key (differing only by case on a filesystem that ignores
  // case, or only by normalization on one that does not) and the map keeps
  // whichever came last, so without this guard one of them silently becomes the
  // other: an internal `Foo/Index.ts` folds onto the door `Foo/index.ts` and its
  // crossing vanishes, and the door itself can fold onto an internal file and be
  // reported as reaching past itself.
  if (graphFileSet(graph).has(filePath)) {
    return filePath;
  }
  return graphFilesByFoldedPath(graph).get(foldGraphPath(filePath)) ?? filePath;
}

// Total, not a bare lookup: resolveSpecifier's settings parameter is optional
// and silently falls back to a lenient default with no project `paths`, so a
// caller that tolerated `undefined` here would resolve every aliased import
// to nothing without anything looking broken. The only miss in practice is a
// graph built from buildGraphWithConfigs' missing-root early return, which
// has no files to resolve specifiers for anyway, so recomputing here is safe.
//
// The settings carry a TypeScript module resolution cache, so keeping them for
// the graph's lifetime is the point rather than a bonus. When that lifetime ends
// is entirely up to the graph cache's own revalidation (see graph-cache.ts).
export const getGraphResolutionSettings = derivedFromGraph(
  (_graph: Graph, rootDir: string) =>
    createResolutionSettings(safeRealpath(rootDir) ?? rootDir),
);

export function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}

export function buildGraphWithConfigs(
  rootDir: string,
  ignoreGlobs: string[],
): { graph: Graph; configPaths: string[] } {
  const resolvedRoot = safeRealpath(rootDir);
  if (resolvedRoot === undefined) {
    return { graph: { importers: new Map(), files: [] }, configPaths: [] };
  }
  const files = collectSourceFiles(resolvedRoot, ignoreGlobs);

  const fileSet = new Set(files);
  // On a case-insensitive filesystem the compiler resolves "./Helper" against
  // helper.ts but hands back the path as written, which matched nothing here and
  // silently dropped the edge. Recover the real casing.
  const filesByLowerCase = ts.sys.useCaseSensitiveFileNames
    ? undefined
    : new Map(files.map((file) => [file.toLowerCase(), file]));
  const importers = new Map<string, string[]>();
  const settings = createResolutionSettings(resolvedRoot);

  for (const file of files) {
    const content = safeReadFile(file);
    if (content === undefined) {
      continue;
    }
    const fromDir = path.dirname(file);

    for (const specifier of extractSpecifiers(content, file)) {
      const resolved = resolveSpecifier(specifier, fromDir, settings);
      if (resolved === undefined) {
        continue;
      }
      const target = fileSet.has(resolved)
        ? resolved
        : filesByLowerCase?.get(resolved.toLowerCase());
      // A file importing itself says nothing about ownership, and the
      // case-insensitive fallback would otherwise invent such an edge from a
      // wrong-case self import.
      if (target === undefined || target === file) {
        continue;
      }

      const existing = importers.get(target);
      if (existing === undefined) {
        importers.set(target, [file]);
      } else if (!existing.includes(file)) {
        existing.push(file);
      }
    }
  }

  const graph: Graph = { importers, files };
  getGraphResolutionSettings.prime(graph, settings);
  // Reuses the member set just built for edge recovery, which is the one index
  // canonicalGraphPath needs that is known equal here for free. Its folded index
  // is deliberately not primed from `filesByLowerCase`: that map is keyed on
  // lower case alone, whereas the fold also normalizes Unicode and skips the
  // lower-casing entirely on a case-sensitive filesystem, so they are different
  // keys and sharing them would reintroduce the mismatch this exists to close.
  graphFileSet.prime(graph, fileSet);
  return { graph, configPaths: settings.configPaths };
}
