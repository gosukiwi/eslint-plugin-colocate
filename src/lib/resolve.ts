import path from "node:path";
import ts from "typescript";
import { safeRealpath, safeStat } from "./fs-safe.js";
import { isSourceFile, SOURCE_EXTS } from "./scope.js";

export interface ResolutionSettings {
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
  configPaths: string[];
}

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
