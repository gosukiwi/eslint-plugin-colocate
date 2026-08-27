import path from "node:path";
import ts from "typescript";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { isSourceFile, SOURCE_EXTS } from "./scope.js";

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

  // tsc reports a diagnostic for a malformed `paths` entry but still hands the
  // raw value straight back in options.paths, so a one-bracket typo
  // (`"@/*": "src/*"` instead of `["src/*"]`) or a non-string target arrives
  // here exactly as written. Taken on trust, that threw a TypeError out of the
  // rule and killed the entire lint run with no results at all - the one thing
  // the filesystem handling everywhere else is careful never to do.
  const targets = paths[pattern];
  if (!Array.isArray(targets)) {
    return [];
  }

  return targets
    .filter((target): target is string => typeof target === "string")
    .map((target) => {
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
  let resolvedModule: ts.ResolvedModuleFull | undefined;
  try {
    ({ resolvedModule } = ts.resolveModuleName(
      specifier,
      path.join(fromDir, "__colocate__.ts"),
      options,
      ts.sys,
      settings?.cache,
    ));
  } catch {
    resolvedModule = undefined;
  }

  if (
    resolvedModule !== undefined &&
    isSourceFile(resolvedModule.resolvedFileName)
  ) {
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
