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
  type ResolutionSettings,
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
    // Lazy: measured against eager on a tree where most files import
    // nothing, lazy comes out meaningfully cheaper per file (getGraph is a
    // cache lookup, not a free one, so a file that never calls
    // reportIfPastEntry should not pay for it). context.sourceCode still lets
    // ownership and entry share one graph build per file when both fire on
    // it - see the comment on CachedGraph.lastToken in graph.ts for why a
    // bare file-path repeat cannot be trusted for that, and getGraph's own
    // visitToken short-circuit for why this composes correctly regardless of
    // which rule asks first or whether either is lazy.
    let graph: Graph | undefined;
    let settings: ResolutionSettings | undefined;

    const reportIfPastEntry = (specifier: string, node: ESTree.Node): void => {
      graph ??= getGraph(rootDir, ignore, realFilename, context.sourceCode);
      settings ??= getGraphResolutionSettings(graph, rootDir);
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
      // No barrel exemption here, unlike ownership's namespace-barrel
      // handling: that exemption is about where a file belongs, not about
      // whether reaching through it is legal. A barrel that re-exports a
      // private file under a public name launders the violation - every
      // downstream consumer of the barrel then looks innocent - so `export
      // ... from` is checked exactly like an import. (ownership's predicate
      // is sibling-scoped, so it would not even recognise a cross-directory
      // barrel like this one.)
      ExportNamedDeclaration(node) {
        checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
    };
  },
};

export default rule;
