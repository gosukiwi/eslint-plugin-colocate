import fs from "node:fs";
import path from "node:path";
import type { Rule } from "eslint";
import { getGraph, isSourceFile, isTestFile, matchesIgnore } from "../lib/graph.js";
import {
  countLocalReExports,
  getSharedColocationIssue,
  isPrivateOutsideOwner,
  resolveLayerDirectories,
} from "../lib/owners.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
  layers?: string[];
}

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

function isCssFile(filePath: string): boolean {
  return path.basename(filePath).endsWith(".css");
}

function countDirectoryContentsRecursive(
  dir: string,
): { sourceCount: number; cssCount: number } {
  let sourceCount = 0;
  let cssCount = 0;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const nested = countDirectoryContentsRecursive(fullPath);
      sourceCount += nested.sourceCount;
      cssCount += nested.cssCount;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

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

function isSingletonWrapperDirectory(
  dir: string,
  filename: string,
): boolean {
  const { sourceCount, cssCount } = countDirectoryContentsRecursive(dir);
  if (sourceCount !== 1 || cssCount !== 0) {
    return false;
  }

  const dirName = path.basename(dir);
  const fileBasename = path.basename(filename, path.extname(filename));
  return fileBasename === dirName || fileBasename === "index";
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
      privateOutsideOwner:
        "File is imported by a single owner but sits outside that owner's folder.",
      sharedTooHigh:
        "File is imported by multiple owners but sits above their common ancestor directory.",
      sharedInsideOwner:
        "File is imported by multiple owners but sits inside a single owner's folder.",
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
    const layers = options.layers ?? [];
    const cwd = context.cwd;
    const rootDir = path.isAbsolute(rootOption)
      ? rootOption
      : path.resolve(cwd, rootOption);

    const realRootDir = fs.realpathSync(rootDir);
    const layerDirs = resolveLayerDirectories(cwd, layers);

    return {
      Program(node) {
        const filename = context.filename;
        if (!isSourceFile(filename) || isTestFile(filename)) {
          return;
        }

        const relPath = path.relative(rootDir, filename);
        if (matchesIgnore(relPath, ignore)) {
          return;
        }

        const dir = path.dirname(filename);
        const realDir = fs.realpathSync(dir);
        const realFilename = fs.realpathSync(filename);
        const graph = getGraph(rootDir, ignore);

        if (realDir !== realRootDir && isSingletonWrapperDirectory(dir, filename)) {
          context.report({
            node,
            messageId: "singletonFolder",
          });
        }

        if (
          isPrivateOutsideOwner(realFilename, graph, realRootDir, layerDirs)
        ) {
          context.report({
            node,
            messageId: "privateOutsideOwner",
          });
        }

        const sharedIssue = getSharedColocationIssue(
          realFilename,
          graph,
          realRootDir,
          layerDirs,
        );
        if (sharedIssue !== undefined) {
          context.report({
            node,
            messageId: sharedIssue,
          });
        }

        const basename = path.basename(filename, path.extname(filename));
        if (basename !== "index") {
          return;
        }

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
