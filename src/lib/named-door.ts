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

export function namedDoorReexports(
  filePath: string,
  graph: Graph,
): readonly { target: string; pos: number }[] {
  if (!isNamedDoor(filePath)) {
    return [];
  }
  const content = safeReadFile(filePath);
  if (content === undefined) {
    return [];
  }
  const sourceFile = parseSourceFile(filePath, content);
  const settings = getGraphResolutionSettings(graph);
  const fromDir = path.dirname(filePath);
  const results: { target: string; pos: number }[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isValueReexport(node)
    ) {
      const resolved = resolveSpecifier(
        node.moduleSpecifier.text,
        fromDir,
        settings,
      );
      if (resolved === undefined) {
        return;
      }
      const target = canonicalGraphPath(graph, resolved);
      if (graphHasFile(graph, target)) {
        results.push({ target, pos: node.getStart(sourceFile) });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}
