import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import {
  fingerprintPaths,
  parseSourceFile,
  resolveSpecifier,
  type Graph,
} from "./graph.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

const shellsByGraph = new WeakMap<Graph, Set<string>>();
const layerDirsCache = new Map<string, { dirs: string[]; fingerprint: string }>();

export function countLocalReExports(indexFile: string, dir: string): number {
  const content = fs.readFileSync(indexFile, "utf8");
  const realDir = fs.realpathSync(dir);
  const sourceFile = parseSourceFile(indexFile, content);
  let count = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        const resolved = resolveSpecifier(specifier, dir);
        if (resolved !== undefined && path.dirname(resolved) === realDir) {
          count += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return count;
}

function isNamespaceBarrel(filePath: string): boolean {
  const basename = path.basename(filePath, path.extname(filePath));
  if (basename !== "index") {
    return false;
  }
  return countLocalReExports(filePath, path.dirname(filePath)) >= 2;
}

function directoryHasMatchingEntry(dir: string, graph: Graph): boolean {
  const dirName = path.basename(dir);
  return graph.files.some((file) => {
    return (
      path.dirname(file) === dir &&
      path.basename(file, path.extname(file)) === dirName
    );
  });
}

export interface Owner {
  kind: "folder" | "standalone";
  path: string;
}

export function getOwner(filePath: string, graph: Graph, rootDir: string): Owner {
  let dir = path.dirname(filePath);
  const realRoot = fs.realpathSync(rootDir);

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

function getRoots(graph: Graph): Set<string> {
  const roots = new Set<string>();
  for (const file of graph.files) {
    const importers = graph.importers.get(file) ?? [];
    if (importers.length === 0) {
      roots.add(file);
    }
  }
  return roots;
}

export function getShells(graph: Graph): Set<string> {
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
    if (
      importers.length > 0 &&
      importers.every((importer) => roots.has(importer))
    ) {
      shells.add(file);
    }
  }

  shellsByGraph.set(graph, shells);
  return shells;
}

export function getColocationConsumers(
  filePath: string,
  graph: Graph,
  shells: Set<string>,
): string[] {
  const importers = graph.importers.get(filePath) ?? [];
  return importers.filter(
    (importer) => !shells.has(importer) && !isNamespaceBarrel(importer),
  );
}

function isInsideDir(filePath: string, dir: string): boolean {
  return filePath.startsWith(dir + path.sep);
}

function isMatchingNameEntry(filePath: string, ownerDir: string): boolean {
  return (
    path.dirname(filePath) === ownerDir &&
    path.basename(filePath, path.extname(filePath)) === path.basename(ownerDir)
  );
}

function collectLayerDirs(
  dir: string,
  cwd: string,
  layerGlobs: string[],
  out: string[],
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(cwd, fullPath).split(path.sep).join("/");
    if (layerGlobs.some((glob) => minimatch(relPath, glob))) {
      out.push(fs.realpathSync(fullPath));
    }
    collectLayerDirs(fullPath, cwd, layerGlobs, out);
  }
}

export function resolveLayerDirectories(
  cwd: string,
  layerGlobs: string[],
): string[] {
  if (layerGlobs.length === 0) {
    return [];
  }

  const key = cwd + "\0" + layerGlobs.join("\0");
  const dirs: string[] = [];
  collectLayerDirs(cwd, cwd, layerGlobs, dirs);
  const fingerprint = fingerprintPaths(dirs) + "\0" + layerGlobs.join("\0");
  const cached = layerDirsCache.get(key);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return cached.dirs;
  }

  layerDirsCache.set(key, { dirs, fingerprint });
  return dirs;
}

export function isLayerPublicModule(
  filePath: string,
  layerDirs: string[],
): boolean {
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
  return fileBase === folderName;
}

export function shouldSkipColocation(
  filePath: string,
  graph: Graph,
  layerDirs: string[],
): boolean {
  const shells = getShells(graph);
  if (shells.has(filePath)) {
    return true;
  }
  if (isLayerPublicModule(filePath, layerDirs)) {
    return true;
  }
  return getColocationConsumers(filePath, graph, shells).length === 0;
}

function collectConsumerOwners(
  filePath: string,
  graph: Graph,
  rootDir: string,
): Map<string, Owner> {
  const shells = getShells(graph);
  const consumers = getColocationConsumers(filePath, graph, shells);
  const owners = new Map<string, Owner>();
  for (const consumer of consumers) {
    const owner = getOwner(consumer, graph, rootDir);
    owners.set(owner.path, owner);
  }
  return owners;
}

export function isPrivateOutsideOwner(
  filePath: string,
  graph: Graph,
  rootDir: string,
  layerDirs: string[],
): boolean {
  if (shouldSkipColocation(filePath, graph, layerDirs)) {
    return false;
  }

  const owners = collectConsumerOwners(filePath, graph, rootDir);

  if (owners.size !== 1) {
    return false;
  }

  const owner = owners.values().next().value;
  if (owner === undefined) {
    return false;
  }
  if (owner.kind === "folder") {
    if (isMatchingNameEntry(filePath, owner.path)) {
      return false;
    }
    return !isInsideDir(filePath, owner.path);
  }

  return filePath !== owner.path;
}

function ownerDir(owner: Owner): string {
  return owner.kind === "folder" ? owner.path : path.dirname(owner.path);
}

function longestCommonAncestor(dirs: string[]): string {
  const segments = dirs.map((dir) => dir.split(path.sep));
  const minLen = Math.min(...segments.map((parts) => parts.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const part = segments[0][i];
    if (segments.every((parts) => parts[i] === part)) {
      common.push(part);
    } else {
      break;
    }
  }
  if (common.length === 0) {
    return path.sep;
  }
  return common.join(path.sep);
}

export function getSharedColocationIssue(
  filePath: string,
  graph: Graph,
  rootDir: string,
  layerDirs: string[],
): "sharedTooHigh" | "sharedInsideOwner" | undefined {
  if (shouldSkipColocation(filePath, graph, layerDirs)) {
    return undefined;
  }

  const owners = collectConsumerOwners(filePath, graph, rootDir);
  if (owners.size < 2) {
    return undefined;
  }

  const ownerDirs = [...new Set([...owners.values()].map(ownerDir))];
  const lca = longestCommonAncestor(ownerDirs);
  const containing = ownerDirs.filter((dir) => isInsideDir(filePath, dir));
  if (containing.length === 1 && containing[0] !== lca) {
    return "sharedInsideOwner";
  }
  if (filePath !== lca && !isInsideDir(filePath, lca)) {
    return "sharedTooHigh";
  }
  return undefined;
}
