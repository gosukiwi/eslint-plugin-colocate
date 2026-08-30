import path from "node:path";
import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { findCrossedGate, type CrossedGate } from "../lib/gates.js";
import { canonicalGraphPath, getGraphResolutionSettings } from "../lib/graph.js";
import { isNamedDoor, namedDoorReexports } from "../lib/named-door.js";
import { requireIsShadowed } from "../lib/require-binding.js";
import { resolveSpecifier } from "../lib/resolve.js";
import { resolveSubject, type Subject } from "../lib/subject.js";

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

interface TypeImportNode {
  source?: ESTree.Node;
  argument?: { literal?: ESTree.Node };
}

interface ImportEqualsNode {
  moduleReference?: { type: string; expression?: ESTree.Node };
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
      namedDoorReexport:
        "Named door '{{door}}' re-exports '{{target}}'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
      reachesPastEntry:
        "'{{target}}' is inside module '{{module}}'; import it through '{{entry}}', or move it out of '{{module}}' if it is not part of it.",
    },
  },
  create(context) {
    const subject = resolveSubject(context);
    if (subject === undefined) {
      return {};
    }

    const reexportsByPos = isNamedDoor(subject.file)
      ? new Map(
          namedDoorReexports(
            subject.file,
            subject.graph(),
            context.sourceCode.getText(),
          ).map((reexport) => [
            reexport.pos,
            reexport.target,
          ]),
        )
      : undefined;

    const reportNamedDoorReexport = (node: ESTree.Node): void => {
      if (reexportsByPos === undefined) {
        return;
      }
      const start = node.range?.[0];
      if (start === undefined) {
        return;
      }
      const target = reexportsByPos.get(start);
      if (target === undefined) {
        return;
      }
      context.report({
        node,
        messageId: "namedDoorReexport",
        data: {
          door: subject.display(subject.file),
          target: subject.display(target),
        },
      });
    };

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
      ExportNamedDeclaration: (node) => {
        check(node.source);
        reportNamedDoorReexport(node);
      },
      ExportAllDeclaration: (node) => {
        check(node.source);
        reportNamedDoorReexport(node);
      },
      ExportDefaultDeclaration: (node) => {
        reportNamedDoorReexport(node);
      },
      ImportExpression: (node) => check(node.source),
      TSImportType: (node: TypeImportNode) =>
        check(node.source ?? node.argument?.literal),
      TSImportEqualsDeclaration: (node: ImportEqualsNode & ESTree.Node) => {
        if (node.moduleReference?.type === "TSExternalModuleReference") {
          check(node.moduleReference.expression);
        }
        reportNamedDoorReexport(node);
      },
      CallExpression: (node) => {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "require" ||
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
