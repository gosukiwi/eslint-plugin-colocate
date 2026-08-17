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

const STYLESHEET_EXTS = [".css", ".scss", ".sass", ".less", ".styl"] as const;

function isStylesheet(filePath: string): boolean {
  const basename = path.basename(filePath);
  return STYLESHEET_EXTS.some((ext) => basename.endsWith(ext));
}

function countSourceFilesRecursive(
  dir: string,
  rootDir: string,
  ignore: string[],
): number {
  let sourceCount = 0;

  for (const entry of safeReaddir(dir)) {
    const fullPath = path.join(dir, entry.name);
    // Files excluded from the graph must not count here either, or an ignored
    // generated file keeps a wrapper directory looking populated.
    if (matchesIgnore(path.relative(rootDir, fullPath), ignore)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      sourceCount += countSourceFilesRecursive(fullPath, rootDir, ignore);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(fullPath)) {
      sourceCount += 1;
    }
  }

  return sourceCount;
}

// Only beside the file: a stylesheet several directories down is not a
// companion, and treating it as one silently exempted the wrapper.
function hasCompanionStylesheet(dir: string): boolean {
  return safeReaddir(dir).some(
    (entry) => entry.isFile() && isStylesheet(entry.name),
  );
}

function isSingletonWrapperDirectory(
  dir: string,
  filename: string,
  rootDir: string,
  ignore: string[],
): boolean {
  if (
    countSourceFilesRecursive(dir, rootDir, ignore) !== 1 ||
    hasCompanionStylesheet(dir)
  ) {
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
        additionalProperties: false,
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
        const graph = getGraph(rootDir, ignore, realFilename);
        const layerDirs = resolveLayerDirectories(graph, cwd, layers);
        const ownershipContext = {
          graph,
          rootDir: realRootDir,
          layerDirs,
          shellGlobs,
        };

        if (
          realDir !== realRootDir &&
          isSingletonWrapperDirectory(realDir, realFilename, realRootDir, ignore)
        ) {
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
        if (basename !== "index" || realDir === realRootDir) {
          return;
        }

        const dirName = path.basename(realDir);

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

        const reExports = collectLocalReExports(realFilename, realDir);
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
