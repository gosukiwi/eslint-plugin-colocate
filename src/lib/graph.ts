import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import {
  safeReadFile,
  safeReaddir,
  safeRealpath,
  safeStat,
} from "./fs-safe.js";

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
    p.split(path.sep).includes("__tests__") ||
    /\.(test|spec)\./.test(path.basename(p))
  );
}

export interface Graph {
  importers: Map<string, string[]>;
  files: string[];
}

export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".hg",
  ".svn",
]);

const DECLARATION_EXTS = [".d.ts", ".d.mts", ".d.cts"] as const;

export function isSourceFile(p: string): boolean {
  if (DECLARATION_EXTS.some((ext) => p.endsWith(ext))) {
    return false;
  }
  return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}

export function matchesIgnore(relPath: string, ignoreGlobs: string[]): boolean {
  const normalized = relPath.split(path.sep).join("/");
  return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}

function shouldSkip(relPath: string, ignoreGlobs: string[]): boolean {
  return matchesIgnore(relPath, ignoreGlobs);
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreGlobs: string[],
  files: Set<string>,
  visitedDirs: Set<string>,
): void {
  const realDir = safeRealpath(dir);
  if (realDir === undefined || visitedDirs.has(realDir)) {
    return;
  }
  visitedDirs.add(realDir);

  for (const entry of safeReaddir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    // readdir reports a symlink as neither file nor directory, so entries were
    // dropped here while the resolver happily followed them - a module behind a
    // linked directory was invisible as a consumer. Stat follows the link.
    const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
    const isDirectory = entry.isSymbolicLink()
      ? (stat?.isDirectory() ?? false)
      : entry.isDirectory();
    const isFile = entry.isSymbolicLink()
      ? (stat?.isFile() ?? false)
      : entry.isFile();

    if (isDirectory) {
      if (SKIP_DIRS.has(entry.name) || shouldSkip(relPath, ignoreGlobs)) {
        continue;
      }
      walkDir(fullPath, rootDir, ignoreGlobs, files, visitedDirs);
      continue;
    }

    if (!isFile || shouldSkip(relPath, ignoreGlobs)) {
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(fullPath)) {
      const realPath = safeRealpath(fullPath);
      if (realPath !== undefined) {
        // A Set because following symlinks can reach the same real file twice.
        files.add(realPath);
      }
    }
  }
}

function scriptKindFromFileName(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (
    fileName.endsWith(".js") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function parseSourceFile(
  fileName: string,
  content: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ false,
    scriptKindFromFileName(fileName),
  );
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function extractSpecifiers(content: string, fileName: string): string[] {
  const sourceFile = parseSourceFile(fileName, content);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const text = stringLiteralText(node.moduleSpecifier);
      if (text !== undefined) {
        specifiers.push(text);
      }
    } else if (ts.isExportDeclaration(node)) {
      const text = stringLiteralText(node.moduleSpecifier);
      if (text !== undefined) {
        specifiers.push(text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const text = stringLiteralText(node.moduleReference.expression);
      if (text !== undefined) {
        specifiers.push(text);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const text = stringLiteralText(node.arguments[0]);
      if (text !== undefined) {
        specifiers.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

export interface ResolutionSettings {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
  configPaths: string[];
}

// One lenient policy for every specifier, whatever the project configures for
// tsc: bundler-style resolution accepts extensionless imports and maps
// "./x.js" onto x.ts, which is how these projects are actually built.
const RESOLUTION_OVERRIDES: ts.CompilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
};

export function findTsconfig(rootDir: string): string | undefined {
  return ts.findConfigFile(rootDir, (fileName) => ts.sys.fileExists(fileName));
}

function loadCompilerOptions(rootDir: string): {
  options: ts.CompilerOptions;
  configPaths: string[];
} {
  const configPath = findTsconfig(rootDir);
  if (configPath === undefined) {
    return { options: {}, configPaths: [] };
  }

  // getParsedCommandLineOfConfigFile (rather than readConfigFile) is what
  // follows "extends", so paths declared in a base config are honoured.
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  if (parsed === undefined) {
    return { options: {}, configPaths: [configPath] };
  }

  const configFile = parsed.options.configFile as
    | { extendedSourceFiles?: string[] }
    | undefined;
  return {
    options: parsed.options,
    configPaths: [configPath, ...(configFile?.extendedSourceFiles ?? [])],
  };
}

export function createResolutionSettings(rootDir: string): ResolutionSettings {
  const { options, configPaths } = loadCompilerOptions(rootDir);
  const resolutionOptions: ts.CompilerOptions = {
    ...options,
    ...RESOLUTION_OVERRIDES,
  };
  return {
    options: resolutionOptions,
    cache: ts.createModuleResolutionCache(
      rootDir,
      (fileName) => fileName,
      resolutionOptions,
    ),
    configPaths,
  };
}

const IMPORT_JS_EXTS = [".mjs", ".cjs", ".jsx", ".js"] as const;

function probeFile(candidate: string): string | undefined {
  const stat = safeStat(candidate);
  if (stat === undefined || !stat.isFile()) {
    return undefined;
  }
  return safeRealpath(candidate);
}

function probeResolvedPath(base: string): string | undefined {
  for (const ext of IMPORT_JS_EXTS) {
    if (base.endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }

  if (isSourceFile(base)) {
    const exact = probeFile(base);
    if (exact !== undefined) {
      return exact;
    }
  }

  for (const ext of SOURCE_EXTS) {
    const candidate = probeFile(base + ext);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  for (const ext of SOURCE_EXTS) {
    const candidate = probeFile(path.join(base, "index" + ext));
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveSpecifier(
  specifier: string,
  fromDir: string,
  settings?: ResolutionSettings,
): string | undefined {
  const options = settings?.options ?? RESOLUTION_OVERRIDES;
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    path.join(fromDir, "__file-ownership-lint__.ts"),
    options,
    ts.sys,
    settings?.cache,
  );

  if (resolvedModule !== undefined && isSourceFile(resolvedModule.resolvedFileName)) {
    const resolved = safeRealpath(resolvedModule.resolvedFileName);
    if (resolved !== undefined) {
      return resolved;
    }
  }

  // Extensions the compiler will not resolve on its own (.cts, .cjs) still
  // resolve here, so relative imports keep working regardless.
  if (specifier.startsWith(".")) {
    return probeResolvedPath(path.resolve(fromDir, specifier));
  }
  return undefined;
}

export function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}

function buildGraphWithConfigs(
  rootDir: string,
  ignoreGlobs: string[],
): { graph: Graph; configPaths: string[] } {
  const resolvedRoot = safeRealpath(rootDir);
  if (resolvedRoot === undefined) {
    return { graph: { importers: new Map(), files: [] }, configPaths: [] };
  }
  const collected = new Set<string>();
  walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, collected, new Set());
  const files = [...collected].sort();

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
      if (target === undefined) {
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

  return { graph: { importers, files }, configPaths: settings.configPaths };
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

interface TsconfigStamp {
  path: string;
  mtimeMs: number;
}

interface CachedGraph {
  graph: Graph;
  stamps: Map<string, FileStamp>;
  configs: TsconfigStamp[];
  // Files linted since the last full validation, used to detect the start of a
  // new lint pass.
  visited: Set<string>;
  validatedAt: number;
  // Whole-second mtimes mean the filesystem (HFS+, some network mounts) cannot
  // distinguish two writes inside the same second, so a same-size edit would
  // slip past the stamp comparison.
  coarseTimestamps: boolean;
}

// Upper bound on how long a stale graph can survive a sequence of lints that
// never revisits a file. Well below the time between a human edit and the next
// lint, and far above the gap between two files in one pass.
const REVALIDATE_AFTER_MS = 100;

const cache = new Map<string, CachedGraph>();

function stampFiles(files: string[]): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();
  for (const file of files) {
    const stat = safeStat(file);
    if (stat !== undefined) {
      stamps.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
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

function tsconfigNeedsRebuild(cached: CachedGraph, rootDir: string): boolean {
  const currentPath = findTsconfig(rootDir);
  const previousPath = cached.configs[0]?.path;
  if (currentPath !== previousPath) {
    return true;
  }
  return cached.configs.some((stamp) => {
    const stat = safeStat(stamp.path);
    return (stat?.mtimeMs ?? 0) !== stamp.mtimeMs;
  });
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
  if (relPath === "" || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return false;
  }
  if (!isSourceFile(currentFile) || isTestFile(currentFile)) {
    return false;
  }

  const segments = relPath.split(path.sep);
  for (let i = 1; i <= segments.length; i += 1) {
    const prefix = segments.slice(0, i).join(path.sep);
    if (SKIP_DIRS.has(segments[i - 1]) || matchesIgnore(prefix, ignoreGlobs)) {
      return false;
    }
  }

  return true;
}

// Every tracked file, not only the one being linted. ESLint lints one file at a
// time, so checking just that file left an edit to any other file invisible: the
// report neither appeared nor - worse - went away once the user fixed the import
// in the file that caused it. Deletions were never noticed at all.
function trackedFilesChanged(cached: CachedGraph, now: number): boolean {
  for (const [file, prev] of cached.stamps) {
    const stat = safeStat(file);
    if (
      stat === undefined ||
      stat.mtimeMs !== prev.mtimeMs ||
      stat.size !== prev.size
    ) {
      return true;
    }
    if (cached.coarseTimestamps) {
      const age = now - stat.mtimeMs;
      if (age >= 0 && age < 1000) {
        return true;
      }
    }
  }
  return false;
}

function needsRebuild(
  cached: CachedGraph,
  currentFile: string,
  rootDir: string,
  ignoreGlobs: string[],
): boolean {
  // Scanning every file for every linted file is O(files^2) stats per run, so
  // validate once per pass instead: seeing a file again means a new pass began.
  // The elapsed-time bound covers passes that never revisit a file.
  const now = Date.now();
  if (
    cached.visited.has(currentFile) ||
    now - cached.validatedAt >= REVALIDATE_AFTER_MS
  ) {
    cached.visited.clear();
    cached.validatedAt = now;
    if (trackedFilesChanged(cached, now)) {
      return true;
    }
  }
  cached.visited.add(currentFile);

  if (cached.stamps.has(currentFile)) {
    return false;
  }
  return isProductionGraphFile(currentFile, rootDir, ignoreGlobs);
}

export function getGraph(
  rootDir: string,
  ignoreGlobs: string[],
  currentFile: string,
): Graph {
  const key = rootDir + "\0" + ignoreGlobs.join("\0");
  const cached = cache.get(key);
  if (
    cached !== undefined &&
    !tsconfigNeedsRebuild(cached, rootDir) &&
    !needsRebuild(cached, currentFile, rootDir, ignoreGlobs)
  ) {
    return cached.graph;
  }

  const { graph, configPaths } = buildGraphWithConfigs(rootDir, ignoreGlobs);
  const stamps = stampFiles(graph.files);
  cache.set(key, {
    graph,
    stamps,
    configs: stampConfigs(configPaths),
    visited: new Set([currentFile]),
    validatedAt: Date.now(),
    coarseTimestamps: hasCoarseTimestamps(stamps),
  });
  return graph;
}
