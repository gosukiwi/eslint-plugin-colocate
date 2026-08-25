import path from "node:path";
import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { safeRealpath } from "../lib/fs-safe.js";
import { findCrossedGate } from "../lib/gates.js";
import { getGraph } from "../lib/graph-cache.js";
import {
  canonicalGraphPath,
  getGraphResolutionSettings,
  type Graph,
} from "../lib/graph.js";
import { requireIsShadowed } from "../lib/require-binding.js";
import { resolveSpecifier, type ResolutionSettings } from "../lib/resolve.js";
import { resolveRootDir } from "../lib/root.js";
import {
  isExcludedPath,
  isOutsideRoot,
  isSourceFile,
  isTestFile,
} from "../lib/scope.js";

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
    // it - see the comment on PassState in graph-cache.ts for why a bare file-
    // path repeat cannot be trusted for that, and getGraph's own visitToken
    // short-circuit for why this composes correctly regardless of which rule
    // asks first or whether either is lazy.
    let graph: Graph | undefined;
    let settings: ResolutionSettings | undefined;
    let importer: string | undefined;

    const reportIfPastEntry = (specifier: string, node: ESTree.Node): void => {
      graph ??= getGraph(rootDir, ignore, realFilename, context.sourceCode);
      settings ??= getGraphResolutionSettings(graph, rootDir);
      // The importer needs the graph's casing for the same reason the target
      // does: realpath does not fold case, so linting `src/f/other.ts` on a
      // case-insensitive disk left isInsideDir comparing a lower-cased path
      // against the gate's real key. It missed, and the file was told to reach
      // into the very directory it lives in - a report whose only fix is to
      // import its own door, i.e. a cycle.
      importer ??= canonicalGraphPath(graph, realFilename);
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
        // Declaration files are outside the model: the walk skips them, they can
        // never be gates, and resolveSpecifier's own probe will still find
        // `types.d.ts` for a "./types.d" specifier - which reported a crossing
        // and named a door that will never re-export the type.
        !isSourceFile(target) ||
        isOutsideRoot(targetRel) ||
        isTestFile(targetRel) ||
        isExcludedPath(targetRel, ignore)
      ) {
        return;
      }

      const crossed = findCrossedGate(target, importer, graph, realRootDir);
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

    // A no-substitution template literal is every bit as static as a quoted
    // string - import(`./x`) loads exactly what import("./x") loads - so it is
    // accepted here. Left out, backticks were a one-character way to launder
    // every crossing in a file past a rule whose whole purpose is a ratchet.
    // One with substitutions is not statically known and stays out, as does
    // anything else non-literal (concatenation, `as string`, identifiers).
    const staticSpecifier = (source: ESTree.Node): string | undefined => {
      if (source.type === "Literal") {
        return typeof source.value === "string" ? source.value : undefined;
      }
      if (
        source.type === "TemplateLiteral" &&
        source.expressions.length === 0 &&
        source.quasis.length === 1
      ) {
        return source.quasis[0]?.value.cooked ?? undefined;
      }
      return undefined;
    };

    const checkSource = (source: ESTree.Node | null | undefined): void => {
      if (source === null || source === undefined) {
        return;
      }
      const specifier = staticSpecifier(source);
      if (specifier === undefined) {
        return;
      }
      reportIfPastEntry(specifier, source);
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
      ImportExpression(node) {
        checkSource(node.source);
      },
      // `import("./x").T` and `typeof import("./x")` are TSImportType, not
      // ImportExpression. Without this visitor the rule's answer depended on
      // which of two equivalent type-import spellings the author picked:
      // `import type { T } from "./x"` was gated and the inline form - what
      // generated code and files avoiding top-level imports emit - was not,
      // contradicting the "type-only imports treated like value imports"
      // invariant. Untyped for the same reason as TSImportEqualsDeclaration.
      //
      // Both AST shapes are handled because the property moved: `source`
      // exists only from @typescript-eslint/parser 8.48, and before that the
      // specifier sits on `argument`, a TSLiteralType wrapping the same
      // Literal. This plugin pins no parser version (eslint is its only peer
      // dependency), so reading `source` alone left the visitor silently
      // inert - checkSource would just receive undefined and return - on every
      // 8.x below 8.48 that a user is free to install.
      TSImportType(node: unknown) {
        const typeImport = node as {
          source?: ESTree.Node;
          argument?: { literal?: ESTree.Node };
        };
        checkSource(typeImport.source ?? typeImport.argument?.literal);
      },
      // Not an ESTree node, so it arrives untyped from the TypeScript parser -
      // `unknown` is honest about that, and RuleListener's index signature
      // accepts any parameter annotation here contravariantly.
      TSImportEqualsDeclaration(node: unknown) {
        const reference = (
          node as {
            moduleReference: { type: string; expression?: ESTree.Node };
          }
        ).moduleReference;
        if (reference.type === "TSExternalModuleReference") {
          checkSource(reference.expression);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "require" ||
          // parse.ts takes arguments[0] at any arity, so require("./x", opts)
          // is still an edge there; narrowed to exactly one argument here
          // deliberately, since a real CJS require never takes a second one.
          node.arguments.length !== 1
        ) {
          return;
        }
        if (requireIsShadowed(context.sourceCode, node)) {
          return;
        }
        checkSource(node.arguments[0]);
      },
    };
  },
};

export default rule;
