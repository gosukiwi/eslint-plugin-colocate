import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";

export const SOURCE_EXTS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
] as const;

export function isTestFile(p: string): boolean {
  return (
    p.includes("/__tests__/") || /\.(test|spec)\./.test(path.basename(p))
  );
}

export interface Graph {
  importers: Map<string, string[]>;
  files: string[];
}

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

const FROM_RE = /\bfrom\s+["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /import\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

function isSourceFile(p: string): boolean {
  if (p.endsWith(".d.ts")) {
    return false;
  }
  return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}

function shouldSkip(relPath: string, ignoreGlobs: string[]): boolean {
  const normalized = relPath.split(path.sep).join("/");
  return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreGlobs: string[],
  files: string[],
): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || shouldSkip(relPath, ignoreGlobs)) {
        continue;
      }
      walkDir(fullPath, rootDir, ignoreGlobs, files);
      continue;
    }

    if (!entry.isFile() || shouldSkip(relPath, ignoreGlobs)) {
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(fullPath)) {
      files.push(fs.realpathSync(fullPath));
    }
  }
}

function extractSpecifiers(content: string): string[] {
  const specifiers: string[] = [];

  for (const match of content.matchAll(FROM_RE)) {
    specifiers.push(match[1]);
  }
  for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
    specifiers.push(match[1]);
  }
  for (const match of content.matchAll(DYNAMIC_IMPORT_RE)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

function resolveSpecifier(
  specifier: string,
  fromDir: string,
): string | undefined {
  const base = path.resolve(fromDir, specifier);

  if (fs.existsSync(base)) {
    const stat = fs.statSync(base);
    if (stat.isFile() && isSourceFile(base)) {
      return fs.realpathSync(base);
    }
  }

  for (const ext of SOURCE_EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }

  for (const ext of SOURCE_EXTS) {
    const candidate = path.join(base, "index" + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.realpathSync(candidate);
    }
  }

  return undefined;
}

export function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  const resolvedRoot = fs.realpathSync(rootDir);
  const files: string[] = [];
  walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, files);
  files.sort();

  const fileSet = new Set(files);
  const importers = new Map<string, string[]>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const fromDir = path.dirname(file);

    for (const specifier of extractSpecifiers(content)) {
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolved = resolveSpecifier(specifier, fromDir);
      if (resolved === undefined || !fileSet.has(resolved)) {
        continue;
      }

      const existing = importers.get(resolved);
      if (existing === undefined) {
        importers.set(resolved, [file]);
      } else if (!existing.includes(file)) {
        existing.push(file);
      }
    }
  }

  return { importers, files };
}

const cache = new Map<string, Graph>();

export function getGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  const key = rootDir + "\0" + ignoreGlobs.join("\0");
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const graph = buildGraph(rootDir, ignoreGlobs);
  cache.set(key, graph);
  return graph;
}
