import path from "node:path";
import ts from "typescript";
import { derivedFromGraph } from "./derived.js";
import { safeReadFile, safeRealpath } from "./fs-safe.js";
import { extractSpecifiers } from "./parse.js";
import { createResolutionSettings, resolveSpecifier, type ResolutionSettings } from "./resolve.js";
import { collectSourceFiles } from "./walk.js";

export interface Graph {
  readonly importers: ReadonlyMap<string, readonly string[]>;
  readonly files: readonly string[];
}

const graphFileSet = derivedFromGraph((graph) => new Set(graph.files));

export function graphHasFile(graph: Graph, filePath: string): boolean {
  return graphFileSet(graph).has(filePath);
}

function foldGraphPath(filePath: string): string {
  const normalized = filePath.normalize("NFC");
  return ts.sys.useCaseSensitiveFileNames
    ? normalized
    : normalized.toLowerCase();
}

const graphFilesByFoldedPath = derivedFromGraph(
  (graph) => new Map(graph.files.map((file) => [foldGraphPath(file), file])),
);

export function canonicalGraphPath(graph: Graph, filePath: string): string {
  if (graphFileSet(graph).has(filePath)) {
    return filePath;
  }
  return graphFilesByFoldedPath(graph).get(foldGraphPath(filePath)) ?? filePath;
}

function noProjectResolutionSettings(): ResolutionSettings {
  const resolutionOptions: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };
  return {
    options: resolutionOptions,
    cache: ts.createModuleResolutionCache(
      "/",
      (fileName) => fileName,
      resolutionOptions,
    ),
    configPaths: [],
  };
}

export const getGraphResolutionSettings = derivedFromGraph((_graph: Graph) =>
  noProjectResolutionSettings(),
);

export function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}

export function buildGraphFromFiles(
  files: readonly string[],
  resolvedRoot: string,
): { graph: Graph; configPaths: string[] } {
  const fileSet = new Set(files);
  const filesByLowerCase = ts.sys.useCaseSensitiveFileNames
    ? undefined
    : new Map(files.map((file) => [file.toLowerCase(), file]));
  const importers = new Map<string, string[]>();
  const settings = createResolutionSettings(resolvedRoot);

  for (const file of files) {
    const realFile = safeRealpath(file);
    if (realFile !== undefined && realFile !== file) {
      continue;
    }
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
  graphFileSet.prime(graph, fileSet);
  return { graph, configPaths: settings.configPaths };
}

export function buildGraphWithConfigs(
  rootDir: string,
  ignoreGlobs: string[],
): { graph: Graph; configPaths: string[] } {
  const resolvedRoot = safeRealpath(rootDir);
  if (resolvedRoot === undefined) {
    return { graph: { importers: new Map(), files: [] }, configPaths: [] };
  }
  const { files } = collectSourceFiles(resolvedRoot, ignoreGlobs);
  const { graph, configPaths } = buildGraphFromFiles(files, resolvedRoot);
  return { graph, configPaths };
}
