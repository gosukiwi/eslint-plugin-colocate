import path from "node:path";
import type { Rule } from "eslint";
import { safeReaddir, safeRealpath, safeStat } from "../lib/fs-safe.js";
import {
  getGraph,
  isExcludedPath,
  isOutsideRoot,
  isSourceFile,
  isTestFile,
  matchesIgnore,
  SKIP_DIRS,
} from "../lib/graph.js";
import {
  collectReExports,
  getSharedColocationIssue,
  isPrivateOutsideOwner,
  resolveLayerDirectories,
} from "../lib/owners.js";
import { resolveRootDir } from "../lib/root.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
  layers?: string[];
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
    const relPath = path.relative(rootDir, fullPath);
    // Files excluded from the graph must not count here either, or an ignored
    // generated file keeps a wrapper directory looking populated.
    if (matchesIgnore(relPath, ignore)) {
      continue;
    }

    // Symlinks read as neither file nor directory, so a linked subdirectory of
    // sources used to leave the parent looking like a single-file wrapper.
    const stat = entry.isSymbolicLink() ? safeStat(fullPath) : undefined;
    const isDirectory = entry.isSymbolicLink()
      ? (stat?.isDirectory() ?? false)
      : entry.isDirectory();

    if (isDirectory) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      sourceCount += countSourceFilesRecursive(fullPath, rootDir, ignore);
      continue;
    }

    const isFile = entry.isSymbolicLink()
      ? (stat?.isFile() ?? false)
      : entry.isFile();
    if (!isFile) {
      continue;
    }

    if (isSourceFile(fullPath) && !isTestFile(relPath)) {
      sourceCount += 1;
    }
  }

  return sourceCount;
}

// Only beside the file: a stylesheet several directories down is not a
// companion, and treating it as one silently exempted the wrapper.
function hasCompanionStylesheet(dir: string): boolean {
  return safeReaddir(dir).some((entry) => {
    if (!isStylesheet(entry.name)) {
      return false;
    }
    // readdir reports a symlink as neither file nor directory.
    return entry.isSymbolicLink()
      ? (safeStat(path.join(dir, entry.name))?.isFile() ?? false)
      : entry.isFile();
  });
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
      url: "https://github.com/gosukiwi/eslint-plugin-colocate#what-it-reports",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
          layers: { type: "array", items: { type: "string" } },
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
    const cwd = context.cwd;

    return {
      Program(node) {
        const filename = context.filename;
        if (!isSourceFile(filename)) {
          return;
        }

        // Resolved lazily: a configured root that does not exist, or a linted
        // path that is not on disk (processors, --stdin-filename, a file
        // deleted mid-run), means "nothing to say" rather than a crash.
        const rootDir = resolveRootDir(rootOption, cwd);
        const realRootDir = safeRealpath(rootDir);
        const realFilename = safeRealpath(filename);
        if (realRootDir === undefined || realFilename === undefined) {
          return;
        }

        const relPath = path.relative(realRootDir, realFilename);
        if (
          isOutsideRoot(relPath) ||
          isTestFile(relPath) ||
          isExcludedPath(relPath, ignore)
        ) {
          return;
        }

        const realDir = path.dirname(realFilename);
        // context.sourceCode lets this share one graph build per file with
        // colocate/entry when both are enabled - see the comment on
        // CachedGraph.lastToken in graph.ts.
        const graph = getGraph(
          rootDir,
          ignore,
          realFilename,
          context.sourceCode,
        );
        const layerDirs = resolveLayerDirectories(
          graph,
          cwd,
          layers,
          realRootDir,
        );
        const ownershipContext = { graph, rootDir: realRootDir, layerDirs };
        // Report on the first statement so eslint-disable comments still apply under ESLint 10.
        const reportNode = node.body[0] ?? node;

        if (
          realDir !== realRootDir &&
          isSingletonWrapperDirectory(realDir, realFilename, realRootDir, ignore)
        ) {
          context.report({
            node: reportNode,
            messageId: "singletonFolder",
          });
        }

        if (isPrivateOutsideOwner(realFilename, ownershipContext)) {
          context.report({
            node: reportNode,
            messageId: "privateOutsideOwner",
          });
        }

        const sharedIssue = getSharedColocationIssue(
          realFilename,
          ownershipContext,
        );
        if (sharedIssue !== undefined) {
          context.report({
            node: reportNode,
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

        const { local, total } = collectReExports(realFilename, realDir);
        // An index that also re-exports modules from elsewhere is an aggregator,
        // not a stand-in for one sibling: the message would name a "named entry
        // file" that does not exist and dropping the barrel would lose the rest.
        if (local.length !== 1 || total !== 1) {
          return;
        }
        // Only modules the graph knows about, so the message cannot point at a
        // file the user has excluded.
        const graphFiles = new Set(graph.files);
        if (!graphFiles.has(local[0])) {
          return;
        }

        // Re-exporting the directory's own named entry keeps the folder a real
        // owner; the barrel only makes `./Foo` resolve to `Foo/Foo.ts`.
        const target = local[0];
        if (path.basename(target, path.extname(target)) === dirName) {
          return;
        }

        context.report({
          node: reportNode,
          messageId: "mismatchedEntry",
        });
      },
    };
  },
};

export default rule;
