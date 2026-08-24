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

// Takes a path relative to the root: given an absolute one, a `__tests__`
// directory anywhere ABOVE the project would have disabled the rule entirely.
export function isTestFile(relPath: string): boolean {
  return (
    relPath.split(path.sep).includes("__tests__") ||
    /\.(test|spec)\./.test(path.basename(relPath))
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

export function isOutsideRoot(relPath: string): boolean {
  return (
    relPath === "" ||
    relPath === ".." ||
    // Not startsWith("..") - a directory named "..data" (Kubernetes mounts one)
    // is inside the root.
    relPath.startsWith(".." + path.sep) ||
    path.isAbsolute(relPath)
  );
}

// A file is excluded when it, or any directory above it, is skipped or ignored -
// which is what walkDir does as it descends. Checking only the file's own path
// let an ignore glob naming a directory ("gen" rather than "gen/**") pass, and
// never consulted SKIP_DIRS at all.
export function isExcludedPath(relPath: string, ignoreGlobs: string[]): boolean {
  const segments = relPath.split(path.sep);
  for (let i = 1; i <= segments.length; i += 1) {
    if (SKIP_DIRS.has(segments[i - 1])) {
      return true;
    }
    if (matchesIgnore(segments.slice(0, i).join(path.sep), ignoreGlobs)) {
      return true;
    }
  }
  return false;
}

function shouldSkip(relPath: string, ignoreGlobs: string[]): boolean {
  return matchesIgnore(relPath, ignoreGlobs);
}

function isWithinRoot(candidate: string, rootDir: string): boolean {
  return candidate === rootDir || candidate.startsWith(rootDir + path.sep);
}

function walkDir(
  dir: string,
  rootDir: string,
  ignoreGlobs: string[],
  files: Set<string>,
  ancestorRealDirs: Set<string>,
  linkedRealDirs: Set<string>,
  behindLink: boolean,
): void {
  const realDir = safeRealpath(dir);
  // Guarded per branch rather than globally: two sibling links to one real
  // directory are both legitimate, and a global set let whichever path was
  // walked first decide the other's fate - so an ignore glob aimed at a link
  // erased the real directory too.
  if (realDir === undefined || ancestorRealDirs.has(realDir)) {
    return;
  }
  const nested = new Set(ancestorRealDirs).add(realDir);

  for (const entry of safeReaddir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);

    // readdir reports a symlink as neither file nor directory, so entries were
    // dropped here while the resolver followed them happily - a module behind a
    // linked directory was invisible as a consumer. Stat follows the link.
    const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
    const isDirectory = entry.isSymbolicLink()
      ? (stat?.isDirectory() ?? false)
      : entry.isDirectory();
    const isFile = entry.isSymbolicLink()
      ? (stat?.isFile() ?? false)
      : entry.isFile();

    if (!isDirectory && !isFile) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name) || shouldSkip(relPath, ignoreGlobs)) {
      continue;
    }

    // Only links (and anything below one) need resolving; on a tree with no
    // symlinks fullPath is already canonical, because the walk started from the
    // resolved root.
    const isLink = entry.isSymbolicLink();
    const realPath =
      isLink || behindLink ? safeRealpath(fullPath) : fullPath;
    if (realPath === undefined) {
      continue;
    }
    // Links are checked under the path they really point at as well. Anything
    // resolving outside the root stays out of the graph: such files cannot be
    // reported (they are outside root) yet would still act as importers and as
    // owners, which turned a linked-in directory into a phantom second owner and
    // a symlinked entry file into a directory that no longer had an entry.
    // Ignoring a directory also cannot be undone by reaching it through a link.
    if (realPath !== fullPath) {
      if (!isWithinRoot(realPath, rootDir)) {
        continue;
      }
      if (isExcludedPath(path.relative(rootDir, realPath), ignoreGlobs)) {
        continue;
      }
    }

    if (isDirectory) {
      // Sibling links to one real directory are both legitimate, but nesting
      // them makes the walk exponential (2^depth), so each real directory is
      // entered through a link at most once. Directories reached without a link
      // are always walked.
      if (isLink) {
        if (linkedRealDirs.has(realPath)) {
          continue;
        }
        linkedRealDirs.add(realPath);
      }
      walkDir(
        fullPath,
        rootDir,
        ignoreGlobs,
        files,
        nested,
        linkedRealDirs,
        behindLink || isLink,
      );
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(relPath)) {
      // A Set because following symlinks can reach the same real file twice.
      files.add(realPath);
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

function bindsName(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === target;
  }
  return name.elements.some((element) =>
    ts.isBindingElement(element) ? bindsName(element.name, target) : false,
  );
}

function isCreateRequireCall(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === "createRequire";
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "createRequire"
  );
}

/** Whether this scope itself binds `require`, shadowing the CJS one. */
function scopeBindsRequire(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) {
    if (node.parameters.some((p) => bindsName(p.name, "require"))) {
      return true;
    }
  }

  const statements = ts.isSourceFile(node)
    ? node.statements
    : ts.isBlock(node) || ts.isModuleBlock(node)
      ? node.statements
      : undefined;
  if (statements === undefined) {
    return false;
  }

  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!bindsName(declaration.name, "require")) {
          continue;
        }
        // `const require = createRequire(import.meta.url)` IS the real require,
        // so its calls are genuine edges.
        if (isCreateRequireCall(declaration.initializer)) {
          continue;
        }
        return true;
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "require"
    ) {
      return true;
    }
  }

  return false;
}

function extractSpecifiers(content: string, fileName: string): string[] {
  const sourceFile = parseSourceFile(fileName, content);
  const specifiers: string[] = [];

  // Scope-aware: a `require` bound in an unrelated nested scope used to disable
  // every require() edge in the file, while a parameter named require must still
  // shadow it within that function.
  const visit = (node: ts.Node, shadowed: boolean): void => {
    const requireIsCjs = !(shadowed || scopeBindsRequire(node));
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
        (requireIsCjs &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const text = stringLiteralText(node.arguments[0]);
      if (text !== undefined) {
        specifiers.push(text);
      }
    }
    ts.forEachChild(node, (child) => visit(child, !requireIsCjs));
  };

  visit(sourceFile, false);
  return specifiers;
}

export interface ResolutionSettings {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
  configPaths: string[];
}

// Keyed on the graph object: these settings, including the TypeScript module
// resolution cache inside them, live exactly as long as the graph they were
// built for and die when it does. When that happens is entirely up to the
// graph cache's own revalidation (see needsRebuild) - this map just rides
// along with whatever graph object is current.
const settingsByGraph = new WeakMap<Graph, ResolutionSettings>();

// Total, not a bare lookup: resolveSpecifier's settings parameter is optional
// and silently falls back to a lenient default with no project `paths`, so a
// caller that tolerated `undefined` here would resolve every aliased import
// to nothing without anything looking broken. The only miss in practice is a
// graph built from buildGraphWithConfigs' missing-root early return, which
// has no files to resolve specifiers for anyway, so recomputing here is safe.
export function getGraphResolutionSettings(
  graph: Graph,
  rootDir: string,
): ResolutionSettings {
  const cached = settingsByGraph.get(graph);
  if (cached !== undefined) {
    return cached;
  }
  const settings = createResolutionSettings(safeRealpath(rootDir) ?? rootDir);
  settingsByGraph.set(graph, settings);
  return settings;
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

function createResolutionSettings(rootDir: string): ResolutionSettings {
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

// The compiler will not try .cts/.cjs for an extensionless specifier, and for a
// non-relative one there is no path left to probe once it gives up - so the
// mapping is expanded here, longest prefix first, exactly as tsc orders it.
// tsc picks exactly one pattern - an exact key first, otherwise the longest
// matching prefix - and if that pattern's targets do not exist the specifier is
// simply unresolved. Trying every matching pattern invented edges the compiler
// refuses.
function bestPathPattern(
  specifier: string,
  paths: Record<string, string[]>,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(paths, specifier)) {
    return specifier;
  }

  let best: string | undefined;
  let bestPrefixLength = -1;
  for (const pattern of Object.keys(paths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      !specifier.startsWith(prefix) ||
      !specifier.endsWith(suffix) ||
      specifier.length < prefix.length + suffix.length
    ) {
      continue;
    }
    if (prefix.length > bestPrefixLength) {
      bestPrefixLength = prefix.length;
      best = pattern;
    }
  }
  return best;
}

function aliasCandidates(
  specifier: string,
  options: ts.CompilerOptions,
): string[] {
  const paths = options.paths;
  if (paths === undefined) {
    return [];
  }

  const base =
    options.baseUrl ??
    (options as { pathsBasePath?: string }).pathsBasePath ??
    undefined;
  if (base === undefined) {
    return [];
  }

  const pattern = bestPathPattern(specifier, paths);
  if (pattern === undefined) {
    return [];
  }

  const star = pattern.indexOf("*");
  const matched =
    star === -1
      ? ""
      : specifier.slice(star, specifier.length - (pattern.length - star - 1));

  return (paths[pattern] ?? []).map((target) => {
    const targetStar = target.indexOf("*");
    const mapped =
      targetStar === -1
        ? target
        : target.slice(0, targetStar) + matched + target.slice(targetStar + 1);
    return path.resolve(base, mapped);
  });
}

export function resolveSpecifier(
  specifier: string,
  fromDir: string,
  settings?: ResolutionSettings,
): string | undefined {
  const options = settings?.options ?? RESOLUTION_OVERRIDES;
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    path.join(fromDir, "__colocate__.ts"),
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
  // resolve here, for relative and aliased specifiers alike.
  if (specifier.startsWith(".")) {
    return probeResolvedPath(path.resolve(fromDir, specifier));
  }
  for (const candidate of aliasCandidates(specifier, options)) {
    const resolved = probeResolvedPath(candidate);
    if (resolved !== undefined) {
      return resolved;
    }
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
  walkDir(
    resolvedRoot,
    resolvedRoot,
    ignoreGlobs,
    collected,
    new Set(),
    new Set(),
    false,
  );
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
  settingsByGraph.set(graph, settings);
  return { graph, configPaths: settings.configPaths };
}

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
  builtAt: number;
}

// Upper bound on how long a stale graph can survive a sequence of lints that
// never revisits a file. Well below the time between a human edit and the next
// lint, and far above the gap between two files in one pass.
const REVALIDATE_AFTER_MS = 100;

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

const cache = new Map<string, CachedGraph>();

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

function tsconfigNeedsRebuild(cached: CachedGraph, rootDir: string): boolean {
  // Resolved first: the stored path came from the resolved root, so comparing a
  // raw symlinked root found a different config every time and rebuilt the
  // whole graph on every lint.
  const currentPath = findTsconfig(safeRealpath(rootDir) ?? rootDir);
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
  if (isOutsideRoot(relPath)) {
    return false;
  }
  if (!isSourceFile(currentFile) || isTestFile(relPath)) {
    return false;
  }
  return !isExcludedPath(relPath, ignoreGlobs);
}

// Every tracked file, not only the one being linted. ESLint lints one file at a
// time, so checking just that file left an edit to any other file invisible: the
// report neither appeared nor - worse - went away once the user fixed the import
// in the file that caused it. Deletions were never noticed at all.
function trackedFilesChanged(cached: CachedGraph): boolean {
  for (const [file, prev] of cached.stamps) {
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
      stampIsAmbiguous(stat.mtimeMs, cached.builtAt, cached.coarseTimestamps)
    ) {
      return true;
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
    if (trackedFilesChanged(cached)) {
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
    builtAt: Date.now(),
  });
  return graph;
}
