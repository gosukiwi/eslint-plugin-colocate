import path from "node:path";
import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { safeRealpath } from "../lib/fs-safe.js";
import { findCrossedGate } from "../lib/gates.js";
import {
  canonicalGraphPath,
  getGraph,
  getGraphResolutionSettings,
  isExcludedPath,
  isOutsideRoot,
  isSourceFile,
  isTestFile,
  resolveSpecifier,
} from "../lib/graph.js";
import { resolveRootDir } from "../lib/root.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
}

function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require imports to enter a module through its entry file",
      url: "https://github.com/gosukiwi/eslint-plugin-colocate#the-entry-rule",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      reachesPastEntry:
        "'{{target}}' is inside module '{{module}}'; import it through '{{entry}}', or move it out of '{{module}}' if it is not part of it.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    const rootOption = options.root ?? ".";
    const ignore = options.ignore ?? [];

    if (!isSourceFile(context.filename)) {
      return {};
    }

    // Resolved eagerly but tolerantly: a root that is not on disk, or a linted
    // path that is not a real file (processors, --stdin-filename, deleted
    // mid-run), means "nothing to say" rather than a crash.
    const rootDir = resolveRootDir(rootOption, context.cwd);
    const realRootDir = safeRealpath(rootDir);
    const realFilename = safeRealpath(context.filename);
    if (realRootDir === undefined || realFilename === undefined) {
      return {};
    }

    const relPath = path.relative(realRootDir, realFilename);
    if (
      isOutsideRoot(relPath) ||
      isTestFile(relPath) ||
      isExcludedPath(relPath, ignore)
    ) {
      return {};
    }

    const fromDir = path.dirname(realFilename);
    // Fetched eagerly, not on the first specifier: getGraph is a cache lookup
    // even on a hit, so laziness only ever saved work for an import-free file,
    // while costing every caller a mutable local and a WeakMap lookup per
    // specifier. Passing context.sourceCode lets ownership and entry share one
    // graph build per file - see the comment on CachedGraph.lastToken in
    // graph.ts for why a bare file-path repeat cannot be trusted for that.
    const graph = getGraph(rootDir, ignore, realFilename, context.sourceCode);
    const settings = getGraphResolutionSettings(graph, rootDir);

    const reportIfPastEntry = (specifier: string, node: ESTree.Node): void => {
      const resolved = resolveSpecifier(specifier, fromDir, settings);
      if (resolved === undefined) {
        return;
      }
      // fs.realpathSync does not fold case on macOS, so a resolved path carries
      // the specifier's casing. Left uncorrected, "./Feature/FEATURE" misses
      // isEntryFile and reports a door the author already used, while
      // "./feature/helper" misses the gate key and reports nothing at all.
      const target = canonicalGraphPath(graph, resolved);

      const targetRel = path.relative(realRootDir, target);
      if (
        isOutsideRoot(targetRel) ||
        isTestFile(targetRel) ||
        isExcludedPath(targetRel, ignore)
      ) {
        return;
      }

      const crossed = findCrossedGate(target, realFilename, graph, realRootDir);
      if (crossed === undefined) {
        return;
      }

      context.report({
        node,
        messageId: "reachesPastEntry",
        data: {
          target: relativePosix(realRootDir, target),
          module: relativePosix(realRootDir, crossed.dir),
          entry: relativePosix(realRootDir, crossed.entry),
        },
      });
    };

    const checkSource = (source: ESTree.Node | null | undefined): void => {
      if (
        source === null ||
        source === undefined ||
        source.type !== "Literal" ||
        typeof source.value !== "string"
      ) {
        return;
      }
      reportIfPastEntry(source.value, source);
    };

    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
    };
  },
};

export default rule;
