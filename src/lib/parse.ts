import ts from "typescript";
import { scopeBindsRequire } from "./require-binding.js";

function scriptKindFromFileName(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (
    fileName.endsWith(".js") ||
    fileName.endsWith(".mjs") ||
    fileName.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function parseSourceFile(
  fileName: string,
  content: string,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFromFileName(fileName),
  );
}

export function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return undefined;
}

function importedSpecifier(
  node: ts.Node,
  requireIsCjs: boolean,
): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return stringLiteralText(node.moduleSpecifier);
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return stringLiteralText(node.moduleReference.expression);
  }
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (requireIsCjs &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"))
  ) {
    return stringLiteralText(node.arguments[0]);
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    return stringLiteralText(node.argument.literal);
  }
  return undefined;
}

export function extractSpecifiers(
  content: string,
  fileName: string,
): string[] {
  const sourceFile = parseSourceFile(fileName, content);
  const specifiers: string[] = [];

  const visit = (node: ts.Node, shadowed: boolean): void => {
    const requireIsCjs = !(shadowed || scopeBindsRequire(node));
    const specifier = importedSpecifier(node, requireIsCjs);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, (child) => visit(child, !requireIsCjs));
  };

  visit(sourceFile, false);
  return specifiers;
}
