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
import { parseSourceFile } from "./parse.js";
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

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return undefined;
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

  const reportIdentityExport = (
    node: ts.Node,
    target: string | undefined,
  ): void => {
    if (target !== undefined) {
      results.push({ target, pos: node.getStart(sourceFile) });
    }
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
      const target = resolveInGraph(
        stringLiteralText(node.moduleSpecifier) ?? "",
      );
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

    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isIdentifier(node.name)
    ) {
      const target = resolveInGraph(
        stringLiteralText(node.moduleReference.expression) ?? "",
      );
      if (target !== undefined) {
        origins.set(node.name.text, target);
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          isRealRequire(declaration.initializer, requireIsCjs)
        ) {
          const target = resolveInGraph(
            stringLiteralText(declaration.initializer.arguments[0]) ?? "",
          );
          if (target !== undefined) {
            bindRequireNames(declaration.name, target, origins);
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
        reportIdentityExport(node, target);
        return;
      }
      if (
        node.moduleSpecifier === undefined &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        !node.isTypeOnly
      ) {
        reportIdentityExport(
          node,
          firstValueNamedExportTarget(node.exportClause.elements),
        );
        return;
      }
    }

    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) {
        reportIdentityExport(node, origins.get(node.expression.text));
        return;
      }
      if (
        ts.isCallExpression(node.expression) &&
        isRealRequire(node.expression, requireIsCjs)
      ) {
        reportIdentityExport(
          node,
          resolveInGraph(
            stringLiteralText(node.expression.arguments[0]) ?? "",
          ),
        );
      }
      return;
    }

    if (hasExportModifier(node) && ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isIdentifier(node.name)
      ) {
        reportIdentityExport(
          node,
          resolveInGraph(
            stringLiteralText(node.moduleReference.expression) ?? "",
          ),
        );
        return;
      }
    }

    if (hasExportModifier(node) && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        let target: string | undefined;
        if (declaration.initializer !== undefined) {
          if (
            ts.isIdentifier(declaration.name) &&
            ts.isIdentifier(declaration.initializer)
          ) {
            target = origins.get(declaration.initializer.text);
          } else if (
            ts.isCallExpression(declaration.initializer) &&
            isRealRequire(declaration.initializer, requireIsCjs)
          ) {
            target = resolveInGraph(
              stringLiteralText(declaration.initializer.arguments[0]) ?? "",
            );
          }
        }
        if (target !== undefined) {
          reportIdentityExport(node, target);
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
