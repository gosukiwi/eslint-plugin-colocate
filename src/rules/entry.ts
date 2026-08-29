import path from "node:path";
import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { findCrossedGate, type CrossedGate } from "../lib/gates.js";
import { canonicalGraphPath, getGraphResolutionSettings } from "../lib/graph.js";
import { requireIsShadowed } from "../lib/require-binding.js";
import { resolveSpecifier } from "../lib/resolve.js";
import { resolveSubject, type Subject } from "../lib/subject.js";

/**
 * The specifier this node imports through, or undefined when it is not
 * statically known.
 *
 * A no-substitution template literal is every bit as static as a quoted string -
 * import(`./x`) loads exactly what import("./x") loads - so it is accepted here.
 * Left out, backticks were a one-character way to launder every crossing in a
 * file past a rule whose whole purpose is a ratchet. One with substitutions is
 * not statically known and stays out, as does anything else non-literal
 * (concatenation, `as string`, identifiers).
 */
function staticSpecifier(source: ESTree.Node): string | undefined {
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
}

interface Crossing extends CrossedGate {
  target: string;
}

/**
 * The gate this specifier reaches past, or undefined when the import is legal.
 *
 * Both the target and the importer go through `canonicalGraphPath`, because
 * fs.realpathSync does not fold case. On the importer side a lower-cased linted
 * path left `isInsideDir` comparing against the gate's real key: it missed, and
 * the file was told to reach into the very directory it lives in - a report whose
 * only fix is to import its own door, i.e. a cycle. On the target side a resolved
 * path carries the specifier's casing, so "./Feature/FEATURE" misses `isEntryFile`
 * and reports a door the author already used, while "./feature/helper" misses the
 * gate key and reports nothing at all.
 *
 * `subject.covers` is also what keeps declaration files out: the walk skips them
 * and they can never be gates, but `resolveSpecifier`'s own probe still finds
 * `types.d.ts` for a "./types.d" specifier - which reported a crossing and named
 * a door that will never re-export the type.
 */
function crossedGate(
  specifier: string,
  subject: Subject,
): Crossing | undefined {
  const graph = subject.graph();
  const resolved = resolveSpecifier(
    specifier,
    path.dirname(subject.file),
    getGraphResolutionSettings(graph),
  );
  if (resolved === undefined) {
    return undefined;
  }
  const target = canonicalGraphPath(graph, resolved);
  if (!subject.covers(target)) {
    return undefined;
  }
  const crossed = findCrossedGate(
    target,
    canonicalGraphPath(graph, subject.file),
    graph,
    subject.realRootDir,
  );
  return crossed === undefined ? undefined : { ...crossed, target };
}

// Neither of these is an ESTree node, so neither is in the parser's published
// types. Annotating the visitor parameter with the shape actually read is what
// RuleListener's index signature accepts - its own parameter type is `never`, so
// any annotation is fine contravariantly - and it beats `unknown` plus a cast
// inside the visitor, which hides the shape in the body.
//
// TSImportType carries the specifier in two places because the property moved:
// `source` exists only from @typescript-eslint/parser 8.48, and before that the
// specifier sits on `argument`, a TSLiteralType wrapping the same Literal. This
// plugin pins no parser version (eslint is its only peer dependency), so reading
// `source` alone left the visitor silently inert - check would just receive
// undefined and return - on every 8.x below 8.48 that a user is free to install.
interface TypeImportNode {
  source?: ESTree.Node;
  argument?: { literal?: ESTree.Node };
}

interface ImportEqualsNode {
  moduleReference: { type: string; expression?: ESTree.Node };
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
    const subject = resolveSubject(context);
    if (subject === undefined) {
      return {};
    }

    const check = (source: ESTree.Node | null | undefined): void => {
      if (source === null || source === undefined) {
        return;
      }
      const specifier = staticSpecifier(source);
      if (specifier === undefined) {
        return;
      }
      const crossed = crossedGate(specifier, subject);
      if (crossed === undefined) {
        return;
      }
      context.report({
        node: source,
        messageId: "reachesPastEntry",
        data: {
          target: subject.display(crossed.target),
          module: subject.display(crossed.dir),
          entry: subject.display(crossed.entry),
        },
      });
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      // No barrel exemption here, unlike ownership's namespace-barrel handling:
      // that exemption is about where a file belongs, not about whether reaching
      // through it is legal. A barrel that re-exports a private file under a
      // public name launders the violation - every downstream consumer of the
      // barrel then looks innocent - so `export ... from` is checked exactly like
      // an import. (ownership's predicate is sibling-scoped, so it would not even
      // recognise a cross-directory barrel like this one.)
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      // `import("./x").T` and `typeof import("./x")` are TSImportType, not
      // ImportExpression. Without this visitor the rule's answer depended on
      // which of two equivalent type-import spellings the author picked:
      // `import type { T } from "./x"` was gated and the inline form - what
      // generated code and files avoiding top-level imports emit - was not,
      // contradicting the "type-only imports treated like value imports"
      // invariant.
      TSImportType: (node: TypeImportNode) =>
        check(node.source ?? node.argument?.literal),
      TSImportEqualsDeclaration: (node: ImportEqualsNode) => {
        if (node.moduleReference.type === "TSExternalModuleReference") {
          check(node.moduleReference.expression);
        }
      },
      CallExpression: (node) => {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "require" ||
          // parse.ts takes arguments[0] at any arity, so require("./x", opts) is
          // still an edge there; narrowed to exactly one argument here
          // deliberately, since a real CJS require never takes a second one.
          node.arguments.length !== 1 ||
          requireIsShadowed(context.sourceCode, node)
        ) {
          return;
        }
        check(node.arguments[0]);
      },
    };
  },
};

export default rule;
