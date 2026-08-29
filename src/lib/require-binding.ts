import type { Scope, SourceCode } from "eslint";
import type * as ESTree from "estree";
import ts from "typescript";

const CREATE_REQUIRE = "createRequire";

const REQUIRE = "require";

function tsIsCreateRequireCall(node: ts.Expression | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) {
    return false;
  }
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === CREATE_REQUIRE;
  }
  return (
    ts.isPropertyAccessExpression(callee) && callee.name.text === CREATE_REQUIRE
  );
}

function estreeIsCreateRequireCall(
  init: ESTree.Node | null | undefined,
): boolean {
  if (init === null || init === undefined || init.type !== "CallExpression") {
    return false;
  }
  const callee = init.callee;
  return (
    (callee.type === "Identifier" && callee.name === CREATE_REQUIRE) ||
    (callee.type === "MemberExpression" &&
      callee.property.type === "Identifier" &&
      callee.property.name === CREATE_REQUIRE)
  );
}

function bindsName(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === target;
  }
  return name.elements.some((element) =>
    ts.isBindingElement(element) ? bindsName(element.name, target) : false,
  );
}

export function scopeBindsRequire(node: ts.Node): boolean {
  if (ts.isFunctionLike(node)) {
    if (node.parameters.some((p) => bindsName(p.name, REQUIRE))) {
      return true;
    }
  }

  const statements = ts.isSourceFile(node)
    ? node.statements
    : ts.isBlock(node) || ts.isModuleBlock(node)
      ? node.statements
      : undefined;
  if (statements === undefined) {
    return false;
  }

  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!bindsName(declaration.name, REQUIRE)) {
          continue;
        }
        if (tsIsCreateRequireCall(declaration.initializer)) {
          continue;
        }
        return true;
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === REQUIRE
    ) {
      return true;
    }
  }

  return false;
}

export function requireIsShadowed(
  sourceCode: SourceCode,
  node: ESTree.Node,
): boolean {
  let scope: Scope.Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.variables.find((entry) => entry.name === REQUIRE);
    if (variable !== undefined && variable.defs.length > 0) {
      return !variable.defs.every((def) => {
        const declarator = def.node as {
          type: string;
          init?: ESTree.Node | null;
        };
        return (
          declarator.type === "VariableDeclarator" &&
          estreeIsCreateRequireCall(declarator.init)
        );
      });
    }
    scope = scope.upper;
  }
  return false;
}
