import fs from "node:fs";
import path from "node:path";
import type { Rule } from "eslint";
import { getGraph, isTestFile, SOURCE_EXTS } from "../lib/graph.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
  layers?: string[];
}

function isSourceFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return SOURCE_EXTS.some((ext) => filePath.endsWith(ext));
}

function isCssFile(filePath: string): boolean {
  return path.basename(filePath).endsWith(".css");
}

function countDirectoryFiles(dir: string): { sourceCount: number; cssCount: number } {
  let sourceCount = 0;
  let cssCount = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (isCssFile(fullPath)) {
      cssCount += 1;
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(fullPath)) {
      sourceCount += 1;
    }
  }

  return { sourceCount, cssCount };
}

const RE_EXPORT_FROM_RE = /export\s+.*?\s+from\s+["']([^"']+)["']/g;

function countLocalReExports(indexFile: string, dir: string): number {
  const content = fs.readFileSync(indexFile, "utf8");
  const realDir = fs.realpathSync(dir);
  let count = 0;

  for (const match of content.matchAll(RE_EXPORT_FROM_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) {
      continue;
    }

    const resolved = resolveSpecifier(specifier, dir);
    if (resolved === undefined) {
      continue;
    }

    const resolvedDir = path.dirname(resolved);
    if (resolvedDir === realDir) {
      count += 1;
    }
  }

  return count;
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

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce dependency-ownership file layout",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
          layers: { type: "array", items: { type: "string" } },
        },
      },
    ],
    messages: {
      privateOutsideOwner: "",
      sharedTooHigh: "",
      sharedInsideOwner: "",
      singletonFolder:
        "Directory contains a single source file with no companion CSS; colocate or flatten the file.",
      mismatchedEntry:
        "Index re-exports a single local module but outside imports use this barrel instead of the named entry file.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    const rootOption = options.root ?? "src";
    const ignore = options.ignore ?? [];
    const cwd = context.cwd;
    const rootDir = path.isAbsolute(rootOption)
      ? rootOption
      : path.resolve(cwd, rootOption);

    const realRootDir = fs.realpathSync(rootDir);

    return {
      Program(node) {
        const filename = context.filename;
        if (!isSourceFile(filename) || isTestFile(filename)) {
          return;
        }

        const dir = path.dirname(filename);
        const realDir = fs.realpathSync(dir);

        if (realDir !== realRootDir) {
          const { sourceCount, cssCount } = countDirectoryFiles(dir);
          if (sourceCount === 1 && cssCount === 0) {
            context.report({
              node,
              messageId: "singletonFolder",
            });
          }
        }

        const basename = path.basename(filename, path.extname(filename));
        if (basename !== "index") {
          return;
        }

        const graph = getGraph(rootDir, ignore);
        const realFilename = fs.realpathSync(filename);
        const dirName = path.basename(dir);

        const filesInDir = graph.files.filter((file) => {
          const fileDir = path.dirname(file);
          return fileDir === realDir;
        });

        const outsideImporters = new Set<string>();
        const outsideImportTargets = new Set<string>();
        let allOutsideImportsTargetIndex = true;

        for (const fileInDir of filesInDir) {
          const importers = graph.importers.get(fileInDir) ?? [];
          for (const importer of importers) {
            const importerDir = path.dirname(importer);
            if (importerDir === realDir) {
              continue;
            }

            outsideImporters.add(importer);
            outsideImportTargets.add(fileInDir);
            if (fileInDir !== realFilename) {
              allOutsideImportsTargetIndex = false;
            }
          }
        }

        if (outsideImporters.size === 0 || !allOutsideImportsTargetIndex) {
          return;
        }

        for (const target of outsideImportTargets) {
          const fileBase = path.basename(target, path.extname(target));
          if (fileBase === dirName) {
            return;
          }
        }

        const reExportCount = countLocalReExports(realFilename, dir);
        if (reExportCount === 1) {
          context.report({
            node,
            messageId: "mismatchedEntry",
          });
        }
      },
    };
  },
};

export default rule;
