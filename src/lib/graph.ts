import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";

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

export function isSourceFile(p: string): boolean {
  if (p.endsWith(".d.ts")) {
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
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
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

export interface PathAlias {
  prefix: string;
  mappedPrefix: string;
}

function loadPathAliases(rootDir: string): PathAlias[] {
  const configPath = ts.findConfigFile(rootDir, (fileName) =>
    ts.sys.fileExists(fileName),
  );
  if (configPath === undefined) {
    return [];
  }

  const { config, error } = ts.readConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  if (error !== undefined || config === undefined) {
    return [];
  }

  const compilerOptions = config.compilerOptions as
    | { baseUrl?: string; paths?: Record<string, string[]> }
    | undefined;
  if (
    compilerOptions === undefined ||
    compilerOptions.baseUrl === undefined ||
    compilerOptions.paths === undefined
  ) {
    return [];
  }

  const baseUrl = path.resolve(path.dirname(configPath), compilerOptions.baseUrl);
  const aliases: PathAlias[] = [];

  for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
    const star = pattern.indexOf("*");
    if (star === -1 || targets === undefined || targets[0] === undefined) {
      continue;
    }
    const prefix = pattern.slice(0, star);
    const target = targets[0];
    const targetStar = target.indexOf("*");
    const mappedPrefix =
      targetStar === -1 ? target : target.slice(0, targetStar);
    aliases.push({
      prefix,
      mappedPrefix: path.resolve(baseUrl, mappedPrefix),
    });
  }

  return aliases;
}

function mapAlias(specifier: string, aliases: PathAlias[]): string | undefined {
  for (const alias of aliases) {
    if (specifier.startsWith(alias.prefix)) {
      return path.join(alias.mappedPrefix, specifier.slice(alias.prefix.length));
    }
  }
  return undefined;
}

const IMPORT_JS_EXTS = [".mjs", ".cjs", ".jsx", ".js"] as const;

function probeResolvedPath(base: string): string | undefined {
  for (const ext of IMPORT_JS_EXTS) {
    if (base.endsWith(ext)) {
      base = base.slice(0, -ext.length);
      break;
    }
  }

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

export function resolveSpecifier(
  specifier: string,
  fromDir: string,
  aliases: PathAlias[] = [],
): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.resolve(fromDir, specifier);
  } else {
    const mapped = mapAlias(specifier, aliases);
    if (mapped === undefined) {
      return undefined;
    }
    base = mapped;
  }

  return probeResolvedPath(base);
}

export function buildGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  const resolvedRoot = fs.realpathSync(rootDir);
  const files: string[] = [];
  walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, files);
  files.sort();

  const fileSet = new Set(files);
  const importers = new Map<string, string[]>();
  const aliases = loadPathAliases(resolvedRoot);

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const fromDir = path.dirname(file);

    for (const specifier of extractSpecifiers(content, file)) {
      const resolved = resolveSpecifier(specifier, fromDir, aliases);
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

export function fingerprintPaths(paths: string[]): string {
  return [...paths]
    .sort()
    .map((p) => {
      const real = fs.realpathSync(p);
      const stat = fs.statSync(real);
      return `${real}\0${stat.mtimeMs}\0${stat.size}`;
    })
    .join("\n");
}

function fingerprintProductionTree(
  rootDir: string,
  ignoreGlobs: string[],
): string {
  const resolvedRoot = fs.realpathSync(rootDir);
  const files: string[] = [];
  walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, files);
  const parts = [fingerprintPaths(files)];
  const configPath = ts.findConfigFile(resolvedRoot, (fileName) =>
    ts.sys.fileExists(fileName),
  );
  if (configPath !== undefined) {
    const stat = fs.statSync(configPath);
    parts.push(`${configPath}\0${stat.mtimeMs}`);
  }
  return parts.join("\n");
}

const cache = new Map<string, { graph: Graph; fingerprint: string }>();

export function getGraph(rootDir: string, ignoreGlobs: string[]): Graph {
  const key = rootDir + "\0" + ignoreGlobs.join("\0");
  const fingerprint = fingerprintProductionTree(rootDir, ignoreGlobs);
  const cached = cache.get(key);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return cached.graph;
  }

  const graph = buildGraph(rootDir, ignoreGlobs);
  cache.set(key, { graph, fingerprint });
  return graph;
}
