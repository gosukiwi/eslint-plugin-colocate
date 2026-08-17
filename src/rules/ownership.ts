import path from "node:path";
import type { Rule } from "eslint";
import { safeReaddir, safeRealpath } from "../lib/fs-safe.js";
import {
  getGraph,
  isSourceFile,
  isTestFile,
  matchesIgnore,
  SKIP_DIRS,
} from "../lib/graph.js";
import {
  collectLocalReExports,
  getSharedColocationIssue,
  isPrivateOutsideOwner,
  resolveLayerDirectories,
} from "../lib/owners.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
  layers?: string[];
  shells?: string[];
}

function isCssFile(filePath: string): boolean {
  return path.basename(filePath).endsWith(".css");
}

function countDirectoryContentsRecursive(
  dir: string,
): { sourceCount: number; cssCount: number } {
  let sourceCount = 0;
  let cssCount = 0;

  for (const entry of safeReaddir(dir)) {
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
          shells: { type: "array", items: { type: "string" } },
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
    const rootOption = options.root ?? ".";
    const ignore = options.ignore ?? [];
    const layers = options.layers ?? [];
    const shellGlobs = options.shells ?? [];
    const cwd = context.cwd;
    const rootDir = path.isAbsolute(rootOption)
      ? rootOption
      : path.resolve(cwd, rootOption);

    return {
      Program(node) {
        const filename = context.filename;
        if (!isSourceFile(filename) || isTestFile(filename)) {
          return;
        }

        // Resolved lazily: a configured root that does not exist, or a linted
        // path that is not on disk (processors, --stdin-filename, a file
        // deleted mid-run), means "nothing to say" rather than a crash.
        const realRootDir = safeRealpath(rootDir);
        const realFilename = safeRealpath(filename);
        if (realRootDir === undefined || realFilename === undefined) {
          return;
        }

        const relPath = path.relative(realRootDir, realFilename);
        if (
          relPath === "" ||
          relPath.startsWith("..") ||
          path.isAbsolute(relPath)
        ) {
          return;
        }
        if (matchesIgnore(relPath, ignore)) {
          return;
        }

        const realDir = path.dirname(realFilename);
        const dir = realDir;
        const layerDirs = resolveLayerDirectories(cwd, layers);
        const graph = getGraph(rootDir, ignore, realFilename);
        const ownershipContext = {
          graph,
          rootDir: realRootDir,
          layerDirs,
          shellGlobs,
        };

        if (realDir !== realRootDir && isSingletonWrapperDirectory(dir, filename)) {
          context.report({
            node,
            messageId: "singletonFolder",
          });
        }

        if (isPrivateOutsideOwner(realFilename, ownershipContext)) {
          context.report({
            node,
            messageId: "privateOutsideOwner",
          });
        }

        const sharedIssue = getSharedColocationIssue(
          realFilename,
          ownershipContext,
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
        let allOutsideImportsTargetIndex = true;

        for (const fileInDir of filesInDir) {
          const importers = graph.importers.get(fileInDir) ?? [];
          for (const importer of importers) {
            const importerDir = path.dirname(importer);
            if (importerDir === realDir) {
              continue;
            }

            outsideImporters.add(importer);
            if (fileInDir !== realFilename) {
              allOutsideImportsTargetIndex = false;
            }
          }
        }

        if (outsideImporters.size === 0 || !allOutsideImportsTargetIndex) {
          return;
        }

        const reExports = collectLocalReExports(realFilename, dir);
        if (reExports.length !== 1) {
          return;
        }

        // Re-exporting the directory's own named entry keeps the folder a real
        // owner; the barrel only makes `./Foo` resolve to `Foo/Foo.ts`.
        const target = reExports[0];
        if (path.basename(target, path.extname(target)) === dirName) {
          return;
        }

        context.report({
          node,
          messageId: "mismatchedEntry",
        });
      },
    };
  },
};

export default rule;
