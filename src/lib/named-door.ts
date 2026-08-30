import path from "node:path";
import ts from "typescript";
import { isEntryFile } from "./gates.js";
import { safeReadFile } from "./fs-safe.js";
import {
  canonicalGraphPath,
  getGraphResolutionSettings,
  graphHasFile,
  type Graph,
} from "./graph.js";
import { parseSourceFile, stringLiteralText } from "./parse.js";
import { scopeBindsRequire } from "./require-binding.js";
import { resolveSpecifier } from "./resolve.js";

export function isNamedDoor(filePath: string): boolean {
  if (!isEntryFile(filePath)) {
    return false;
  }
  return path.basename(filePath, path.extname(filePath)) !== "index";
}

function isValueReexport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }
  if (node.exportClause === undefined) {
    return true;
  }
  if (ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isNamespaceExport(node.exportClause)) {
    return true;
  }
  return false;
}

function peelValueExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isRealRequire(
  node: ts.CallExpression,
  requireIsCjs: boolean,
): boolean {
  return (
    requireIsCjs &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

function bindRequireNames(
  name: ts.BindingName,
  target: string,
  origins: Map<string, string>,
): void {
  if (ts.isIdentifier(name)) {
    origins.set(name.text, target);
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      bindRequireNames(element.name, target, origins);
    }
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    node.modifiers !== undefined &&
    node.modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function originFromBindingName(
  name: ts.BindingName,
  origins: Map<string, string>,
): string | undefined {
  if (ts.isIdentifier(name)) {
    return origins.get(name.text);
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      const target = originFromBindingName(element.name, origins);
      if (target !== undefined) {
        return target;
      }
    }
  }
  return undefined;
}

export function namedDoorReexports(
  filePath: string,
  graph: Graph,
  content?: string,
): readonly { target: string; pos: number }[] {
  if (!isNamedDoor(filePath)) {
    return [];
  }
  const source =
    typeof content === "string"
      ? content
      : safeReadFile(filePath);
  if (source === undefined) {
    return [];
  }
  const sourceFile = parseSourceFile(filePath, source);
  const settings = getGraphResolutionSettings(graph);
  const fromDir = path.dirname(filePath);
  const results: { target: string; pos: number }[] = [];
  const origins = new Map<string, string>();

  const resolveInGraph = (specifier: string): string | undefined => {
    const resolved = resolveSpecifier(specifier, fromDir, settings);
    if (resolved === undefined) {
      return undefined;
    }
    const target = canonicalGraphPath(graph, resolved);
    if (!graphHasFile(graph, target)) {
      return undefined;
    }
    return target;
  };

  const firstValueNamedExportTarget = (
    elements: ts.NodeArray<ts.ExportSpecifier>,
  ): string | undefined => {
    for (const element of elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const localName =
        (element.propertyName !== undefined &&
        ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : undefined) ?? element.name.text;
      const target = origins.get(localName);
      if (target !== undefined) {
        return target;
      }
    }
    return undefined;
  };

  const collectOrigins = (node: ts.Node, requireIsCjs: boolean): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause !== undefined &&
      !node.importClause.isTypeOnly
    ) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) {
        const target = resolveInGraph(specifier);
        if (target !== undefined) {
          const clause = node.importClause;
          if (clause.name !== undefined) {
            origins.set(clause.name.text, target);
          }
          const bindings = clause.namedBindings;
          if (bindings !== undefined) {
            if (ts.isNamespaceImport(bindings)) {
              origins.set(bindings.name.text, target);
            } else if (ts.isNamedImports(bindings)) {
              for (const element of bindings.elements) {
                if (!element.isTypeOnly) {
                  origins.set(element.name.text, target);
                }
              }
            }
          }
        }
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isIdentifier(node.name)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) {
        const target = resolveInGraph(specifier);
        if (target !== undefined) {
          origins.set(node.name.text, target);
        }
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer !== undefined) {
          const peeled = peelValueExpression(declaration.initializer);
          if (
            ts.isCallExpression(peeled) &&
            isRealRequire(peeled, requireIsCjs)
          ) {
            const specifier = stringLiteralText(peeled.arguments[0]);
            if (specifier !== undefined) {
              const target = resolveInGraph(specifier);
              if (target !== undefined) {
                bindRequireNames(declaration.name, target, origins);
              }
            }
          } else if (
            ts.isIdentifier(declaration.name) &&
            ts.isIdentifier(peeled)
          ) {
            const target = origins.get(peeled.text);
            if (target !== undefined) {
              origins.set(declaration.name.text, target);
            }
          }
        }
      }
    }
  };

  const checkExports = (node: ts.Node, requireIsCjs: boolean): void => {
    if (ts.isExportDeclaration(node)) {
      if (
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isValueReexport(node)
      ) {
        const target = resolveInGraph(node.moduleSpecifier.text);
        if (target !== undefined) {
          results.push({ target, pos: node.getStart(sourceFile) });
        }
        return;
      }
      if (
        node.moduleSpecifier === undefined &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        !node.isTypeOnly
      ) {
        const target = firstValueNamedExportTarget(node.exportClause.elements);
        if (target !== undefined) {
          results.push({ target, pos: node.getStart(sourceFile) });
        }
        return;
      }
    }

    if (ts.isExportAssignment(node)) {
      const peeled = peelValueExpression(node.expression);
      if (ts.isIdentifier(peeled)) {
        const target = origins.get(peeled.text);
        if (target !== undefined) {
          results.push({ target, pos: node.getStart(sourceFile) });
        }
        return;
      }
      if (ts.isCallExpression(peeled) && isRealRequire(peeled, requireIsCjs)) {
        const specifier = stringLiteralText(peeled.arguments[0]);
        if (specifier !== undefined) {
          const target = resolveInGraph(specifier);
          if (target !== undefined) {
            results.push({ target, pos: node.getStart(sourceFile) });
          }
        }
      }
      return;
    }

    if (hasExportModifier(node) && ts.isImportEqualsDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        const target = origins.get(node.name.text);
        if (target !== undefined) {
          results.push({ target, pos: node.getStart(sourceFile) });
        }
        return;
      }
    }

    if (hasExportModifier(node) && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const target = originFromBindingName(declaration.name, origins);
        if (target !== undefined) {
          results.push({ target, pos: node.getStart(sourceFile) });
          return;
        }
      }
    }
  };

  const requireIsCjs = !scopeBindsRequire(sourceFile);
  for (const statement of sourceFile.statements) {
    collectOrigins(statement, requireIsCjs);
  }
  for (const statement of sourceFile.statements) {
    checkExports(statement, requireIsCjs);
  }
  return results;
}
