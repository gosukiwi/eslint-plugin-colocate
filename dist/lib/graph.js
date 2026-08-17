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
const DECLARATION_EXTS = [".d.ts", ".d.mts", ".d.cts"];
export function isSourceFile(p) {
    if (DECLARATION_EXTS.some((ext) => p.endsWith(ext))) {
        return false;
    }
    return SOURCE_EXTS.some((ext) => p.endsWith(ext));
}
export function matchesIgnore(relPath, ignoreGlobs) {
    const normalized = relPath.split(path.sep).join("/");
    return ignoreGlobs.some((glob) => minimatch(normalized, glob));
}
export function isOutsideRoot(relPath) {
    return (relPath === "" ||
        relPath === ".." ||
        // Not startsWith("..") - a directory named "..data" (Kubernetes mounts one)
        // is inside the root.
        relPath.startsWith(".." + path.sep) ||
        path.isAbsolute(relPath));
}
// A file is excluded when it, or any directory above it, is skipped or ignored -
// which is what walkDir does as it descends. Checking only the file's own path
// let an ignore glob naming a directory ("gen" rather than "gen/**") pass, and
// never consulted SKIP_DIRS at all.
export function isExcludedPath(relPath, ignoreGlobs) {
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
function shouldSkip(relPath, ignoreGlobs) {
    return matchesIgnore(relPath, ignoreGlobs);
}
function isWithinRoot(candidate, rootDir) {
    return candidate === rootDir || candidate.startsWith(rootDir + path.sep);
}
function walkDir(dir, rootDir, ignoreGlobs, files, ancestorRealDirs, behindLink) {
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
        const realPath = isLink || behindLink ? safeRealpath(fullPath) : fullPath;
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
            if (shouldSkip(path.relative(rootDir, realPath), ignoreGlobs)) {
                continue;
            }
        }
        if (isDirectory) {
            walkDir(fullPath, rootDir, ignoreGlobs, files, nested, behindLink || isLink);
            continue;
        }
        if (isSourceFile(fullPath) && !isTestFile(fullPath)) {
            // A Set because following symlinks can reach the same real file twice.
            files.add(realPath);
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
function declaresRequire(sourceFile) {
    let declared = false;
    const visit = (node) => {
        if (declared) {
            return;
        }
        const named = node;
        if ((ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isVariableDeclaration(node) ||
            ts.isParameter(node) ||
            ts.isBindingElement(node) ||
            ts.isImportSpecifier(node) ||
            ts.isImportClause(node) ||
            ts.isClassDeclaration(node)) &&
            named.name !== undefined &&
            ts.isIdentifier(named.name) &&
            named.name.text === "require") {
            declared = true;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return declared;
}
function extractSpecifiers(content, fileName) {
    const sourceFile = parseSourceFile(fileName, content);
    const specifiers = [];
    // `require` is only the CJS one when the file has not bound that name itself;
    // a local function or parameter called require was producing phantom edges.
    const requireIsCjs = !declaresRequire(sourceFile);
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
        else if (ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)) {
            const text = stringLiteralText(node.moduleReference.expression);
            if (text !== undefined) {
                specifiers.push(text);
            }
        }
        else if (ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (requireIsCjs &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "require"))) {
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
// The compiler will not try .cts/.cjs for an extensionless specifier, and for a
// non-relative one there is no path left to probe once it gives up - so the
// mapping is expanded here, longest prefix first, exactly as tsc orders it.
function aliasCandidates(specifier, options) {
    const paths = options.paths;
    if (paths === undefined) {
        return [];
    }
    const base = options.baseUrl ??
        options.pathsBasePath ??
        undefined;
    if (base === undefined) {
        return [];
    }
    const patterns = Object.keys(paths)
        .filter((pattern) => {
        const star = pattern.indexOf("*");
        return star === -1
            ? pattern === specifier
            : specifier.startsWith(pattern.slice(0, star));
    })
        .sort((a, b) => b.length - a.length);
    const candidates = [];
    for (const pattern of patterns) {
        const star = pattern.indexOf("*");
        const rest = star === -1 ? "" : specifier.slice(star);
        for (const target of paths[pattern] ?? []) {
            const targetStar = target.indexOf("*");
            const mapped = targetStar === -1 ? target : target.slice(0, targetStar) + rest;
            candidates.push(path.resolve(base, mapped));
        }
    }
    return candidates;
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
export function buildGraph(rootDir, ignoreGlobs) {
    return buildGraphWithConfigs(rootDir, ignoreGlobs).graph;
}
function buildGraphWithConfigs(rootDir, ignoreGlobs) {
    const resolvedRoot = safeRealpath(rootDir);
    if (resolvedRoot === undefined) {
        return { graph: { importers: new Map(), files: [] }, configPaths: [] };
    }
    const collected = new Set();
    walkDir(resolvedRoot, resolvedRoot, ignoreGlobs, collected, new Set(), false);
    const files = [...collected].sort();
    const fileSet = new Set(files);
    // On a case-insensitive filesystem the compiler resolves "./Helper" against
    // helper.ts but hands back the path as written, which matched nothing here and
    // silently dropped the edge. Recover the real casing.
    const filesByLowerCase = ts.sys.useCaseSensitiveFileNames
        ? undefined
        : new Map(files.map((file) => [file.toLowerCase(), file]));
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
            }
            else if (!existing.includes(file)) {
                existing.push(file);
            }
        }
    }
    return { graph: { importers, files }, configPaths: settings.configPaths };
}
// Upper bound on how long a stale graph can survive a sequence of lints that
// never revisits a file. Well below the time between a human edit and the next
// lint, and far above the gap between two files in one pass.
const REVALIDATE_AFTER_MS = 100;
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
function hasCoarseTimestamps(stamps) {
    if (stamps.size === 0) {
        return false;
    }
    return [...stamps.values()].every((stamp) => stamp.mtimeMs % 1000 === 0);
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
function isProductionGraphFile(currentFile, rootDir, ignoreGlobs) {
    const realRoot = safeRealpath(rootDir);
    if (realRoot === undefined) {
        return false;
    }
    const relPath = path.relative(realRoot, currentFile);
    if (isOutsideRoot(relPath)) {
        return false;
    }
    if (!isSourceFile(currentFile) || isTestFile(currentFile)) {
        return false;
    }
    return !isExcludedPath(relPath, ignoreGlobs);
}
// Every tracked file, not only the one being linted. ESLint lints one file at a
// time, so checking just that file left an edit to any other file invisible: the
// report neither appeared nor - worse - went away once the user fixed the import
// in the file that caused it. Deletions were never noticed at all.
function trackedFilesChanged(cached, now) {
    for (const [file, prev] of cached.stamps) {
        const stat = safeStat(file);
        if (stat === undefined ||
            stat.mtimeMs !== prev.mtimeMs ||
            stat.size !== prev.size) {
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
function needsRebuild(cached, currentFile, rootDir, ignoreGlobs) {
    // Scanning every file for every linted file is O(files^2) stats per run, so
    // validate once per pass instead: seeing a file again means a new pass began.
    // The elapsed-time bound covers passes that never revisit a file.
    const now = Date.now();
    if (cached.visited.has(currentFile) ||
        now - cached.validatedAt >= REVALIDATE_AFTER_MS) {
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
export function getGraph(rootDir, ignoreGlobs, currentFile) {
    const key = rootDir + "\0" + ignoreGlobs.join("\0");
    const cached = cache.get(key);
    if (cached !== undefined &&
        !tsconfigNeedsRebuild(cached, rootDir) &&
        !needsRebuild(cached, currentFile, rootDir, ignoreGlobs)) {
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
