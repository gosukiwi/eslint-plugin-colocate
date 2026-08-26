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
    /*setParentNodes*/ false,
    scriptKindFromFileName(fileName),
  );
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
}

// The specifier this node imports through, or undefined when it imports
// nothing. `requireIsCjs` decides only whether a bare `require(...)` counts.
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
  return undefined;
}

export function extractSpecifiers(
  content: string,
  fileName: string,
): string[] {
  const sourceFile = parseSourceFile(fileName, content);
  const specifiers: string[] = [];

  // Scope-aware: a `require` bound in an unrelated nested scope used to disable
  // every require() edge in the file, while a parameter named require must still
  // shadow it within that function.
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
