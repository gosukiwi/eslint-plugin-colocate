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
  type Graph,
} from "../lib/graph.js";
import { resolveRootDir } from "../lib/root.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
}

function toPosix(from: string, to: string): string {
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
    // One graph per linted file, fetched on the first specifier rather than up
    // front so a file with no imports does not pay for it.
    let graph: Graph | undefined;

    const check = (specifier: string, node: ESTree.Node): void => {
      graph ??= getGraph(rootDir, ignore, realFilename);
      // Same rootDir passed to getGraph, so the settings are the ones this
      // graph resolved with. The accessor is total: on a miss it computes and
      // memoises, so an aliased specifier can never silently fail to resolve.
      const resolved = resolveSpecifier(
        specifier,
        fromDir,
        getGraphResolutionSettings(graph, rootDir),
      );
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
          target: toPosix(realRootDir, target),
          module: toPosix(realRootDir, crossed.dir),
          entry: toPosix(realRootDir, crossed.entry),
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
      check(source.value, source);
    };

    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
    };
  },
};

export default rule;
