import path from "node:path";
import { minimatch } from "minimatch";
import ts from "typescript";
import { safeReadFile, safeReaddir, safeRealpath, safeStat, } from "./fs-safe.js";
export const SOURCE_EXTS = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".mjs",
    ".cjs",
];
export function isTestFile(p) {
    return (p.split(path.sep).includes("__tests__") ||
        /\.(test|spec)\./.test(path.basename(p)));
}
export const SKIP_DIRS = new Set([
    "node_modules",
    "dist",
    "coverage",
    ".git",
    ".hg",
    ".svn",
]);
export function isSourceFile(p) {
    if (p.endsWith(".d.ts")) {
        return false;
    }
    return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}
export function matchesIgnore(relPath, ignoreGlobs) {
    const normalized = relPath.split(path.sep).join("/");
    return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}
function shouldSkip(relPath, ignoreGlobs) {
    return matchesIgnore(relPath, ignoreGlobs);
}
function walkDir(dir, rootDir, ignoreGlobs, files) {
    for (const entry of safeReaddir(dir)) {
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
            const realPath = safeRealpath(fullPath);
            if (realPath !== undefined) {
                files.push(realPath);
            }
        }
    }
}
function scriptKindFromFileName(fileName) {
    if (fileName.endsWith(".tsx")) {
        return ts.ScriptKind.TSX;
    }
    if (fileName.endsWith(".jsx")) {
        return ts.ScriptKind.JSX;
    }
    if (fileName.endsWith(".js") ||
        fileName.endsWith(".mjs") ||
        fileName.endsWith(".cjs")) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}
export function parseSourceFile(fileName, content) {
    return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, 
    /*setParentNodes*/ false, scriptKindFromFileName(fileName));
}
function stringLiteralText(node) {
    if (node !== undefined && ts.isStringLiteral(node)) {
        return node.text;
    }
    return undefined;
}
function extractSpecifiers(content, fileName) {
    const sourceFile = parseSourceFile(fileName, content);
    const specifiers = [];
    const visit = (node) => {
        if (ts.isImportDeclaration(node)) {
            const text = stringLiteralText(node.moduleSpecifier);
            if (text !== undefined) {
                specifiers.push(text);
            }
        }
        else if (ts.isExportDeclaration(node)) {
            const text = stringLiteralText(node.moduleSpecifier);
            if (text !== undefined) {
                specifiers.push(text);
            }
        }
        else if (ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword) {
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
// One lenient policy for every specifier, whatever the project configures for
// tsc: bundler-style resolution accepts extensionless imports and maps
// "./x.js" onto x.ts, which is how these projects are actually built.
const RESOLUTION_OVERRIDES = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
};
export function findTsconfig(rootDir) {
    return ts.findConfigFile(rootDir, (fileName) => ts.sys.fileExists(fileName));
}
function loadCompilerOptions(rootDir) {
    const configPath = findTsconfig(rootDir);
    if (configPath === undefined) {
        return { options: {}, configPaths: [] };
    }
    // getParsedCommandLineOfConfigFile (rather than readConfigFile) is what
    // follows "extends", so paths declared in a base config are honoured.
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => { },
    });
    if (parsed === undefined) {
        return { options: {}, configPaths: [configPath] };
    }
    const configFile = parsed.options.configFile;
    return {
        options: parsed.options,
        configPaths: [configPath, ...(configFile?.extendedSourceFiles ?? [])],
    };
}
export function createResolutionSettings(rootDir) {
    const { options, configPaths } = loadCompilerOptions(rootDir);
    const resolutionOptions = {
        ...options,
        ...RESOLUTION_OVERRIDES,
    };
    return {
        options: resolutionOptions,
        cache: ts.createModuleResolutionCache(rootDir, (fileName) => fileName, resolutionOptions),
        configPaths,
    };
}
const IMPORT_JS_EXTS = [".mjs", ".cjs", ".jsx", ".js"];
function probeFile(candidate) {
    const stat = safeStat(candidate);
    if (stat === undefined || !stat.isFile()) {
        return undefined;
    }
    return safeRealpath(candidate);
}
function probeResolvedPath(base) {
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
export function resolveSpecifier(specifier, fromDir, settings) {
    const options = settings?.options ?? RESOLUTION_OVERRIDES;
    const { resolvedModule } = ts.resolveModuleName(specifier, path.join(fromDir, "__file-ownership-lint__.ts"), options, ts.sys, settings?.cache);
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
export function buildGraph(rootDir, ignoreGlobs) {
    return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}
function buildGraphWithConfigs(rootDir, ignoreGlobs) {
    const resolvedRoot = safeRealpath(rootDir);
    if (resolvedRoot === undefined) {
        return { graph: { importers: new Map(), files: [] }, configPaths: [] };
    }
    const files = [];
    walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, files);
    files.sort();
    const fileSet = new Set(files);
    const importers = new Map();
    const settings = createResolutionSettings(resolvedRoot);
    for (const file of files) {
        const content = safeReadFile(file);
        if (content === undefined) {
            continue;
        }
        const fromDir = path.dirname(file);
        for (const specifier of extractSpecifiers(content, file)) {
            const resolved = resolveSpecifier(specifier, fromDir, settings);
            if (resolved === undefined || !fileSet.has(resolved)) {
                continue;
            }
            const existing = importers.get(resolved);
            if (existing === undefined) {
                importers.set(resolved, [file]);
            }
            else if (!existing.includes(file)) {
                existing.push(file);
            }
        }
    }
    return { graph: { importers, files }, configPaths: settings.configPaths };
}
const cache = new Map();
function stampFiles(files) {
    const stamps = new Map();
    for (const file of files) {
        const stat = safeStat(file);
        if (stat !== undefined) {
            stamps.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
        }
    }
    return stamps;
}
function stampConfigs(configPaths) {
    const stamps = [];
    for (const configPath of configPaths) {
        const stat = safeStat(configPath);
        stamps.push({ path: configPath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
    return stamps;
}
function tsconfigNeedsRebuild(cached, rootDir) {
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
function isProductionGraphFile(currentFile, rootDir, ignoreGlobs) {
    const relPath = path.relative(rootDir, currentFile);
    if (relPath === "" || relPath.startsWith("..") || path.isAbsolute(relPath)) {
        return false;
    }
    if (!isSourceFile(currentFile) || isTestFile(currentFile)) {
        return false;
    }
    return !matchesIgnore(relPath, ignoreGlobs);
}
function needsRebuild(cached, currentFile, rootDir, ignoreGlobs) {
    const prev = cached.stamps.get(currentFile);
    if (prev === undefined) {
        return isProductionGraphFile(currentFile, rootDir, ignoreGlobs);
    }
    const stat = safeStat(currentFile);
    if (stat === undefined) {
        return true;
    }
    return stat.mtimeMs !== prev.mtimeMs || stat.size !== prev.size;
}
export function getGraph(rootDir, ignoreGlobs, currentFile) {
    const key = rootDir + "\0" + ignoreGlobs.join("\0");
    const cached = cache.get(key);
    if (cached !== undefined &&
        !tsconfigNeedsRebuild(cached, rootDir) &&
        !needsRebuild(cached, currentFile, rootDir, ignoreGlobs)) {
        return cached.graph;
    }
    const { graph, configPaths } = buildGraphWithConfigs(rootDir, ignoreGlobs);
    cache.set(key, {
        graph,
        stamps: stampFiles(graph.files),
        configs: stampConfigs(configPaths),
    });
    return graph;
}
