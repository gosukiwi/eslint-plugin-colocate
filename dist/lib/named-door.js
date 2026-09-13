import path from "node:path";
import ts from "typescript";
import { isEntryFile } from "./gates.js";
import { safeReadFile } from "./fs-safe.js";
import { canonicalGraphPath, getGraphResolutionSettings, graphHasFile, } from "./graph.js";
import { parseSourceFile, stringLiteralText } from "./parse.js";
import { scopeBindsRequire } from "./require-binding.js";
import { resolveSpecifier } from "./resolve.js";
export function isNamedDoor(filePath) {
    if (!isEntryFile(filePath)) {
        return false;
    }
    return path.basename(filePath, path.extname(filePath)) !== "index";
}
function isValueReexport(node) {
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
function peelValueExpression(node) {
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
function isRealRequire(node, requireIsCjs) {
    return (requireIsCjs &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]));
}
function bindRequireNames(name, target, origins) {
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
function hasExportModifier(node) {
    return (ts.canHaveModifiers(node) &&
        node.modifiers !== undefined &&
        node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}
function originFromBindingName(name, origins) {
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
function recordClauseBindings(clause, target, origins) {
    if (clause.name !== undefined) {
        origins.set(clause.name.text, target);
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
        return;
    }
    if (ts.isNamespaceImport(bindings)) {
        origins.set(bindings.name.text, target);
        return;
    }
    if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
            if (!element.isTypeOnly) {
                origins.set(element.name.text, target);
            }
        }
    }
}
function recordImportOrigins(node, scan) {
    const clause = node.importClause;
    if (clause === undefined || clause.isTypeOnly) {
        return;
    }
    const specifier = stringLiteralText(node.moduleSpecifier);
    if (specifier === undefined) {
        return;
    }
    const target = scan.resolve(specifier);
    if (target === undefined) {
        return;
    }
    recordClauseBindings(clause, target, scan.origins);
}
function recordImportEqualsOrigins(node, scan) {
    if (!ts.isExternalModuleReference(node.moduleReference) ||
        !ts.isIdentifier(node.name)) {
        return;
    }
    const specifier = stringLiteralText(node.moduleReference.expression);
    if (specifier === undefined) {
        return;
    }
    const target = scan.resolve(specifier);
    if (target === undefined) {
        return;
    }
    scan.origins.set(node.name.text, target);
}
function recordRequireDeclaration(declaration, call, scan) {
    if (!isRealRequire(call, scan.requireIsCjs)) {
        return;
    }
    const specifier = stringLiteralText(call.arguments[0]);
    if (specifier === undefined) {
        return;
    }
    const target = scan.resolve(specifier);
    if (target === undefined) {
        return;
    }
    bindRequireNames(declaration.name, target, scan.origins);
}
function recordAliasDeclaration(declaration, peeled, scan) {
    if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(peeled)) {
        return;
    }
    const target = scan.origins.get(peeled.text);
    if (target === undefined) {
        return;
    }
    scan.origins.set(declaration.name.text, target);
}
function recordDeclarationOrigin(declaration, scan) {
    if (declaration.initializer === undefined) {
        return;
    }
    const peeled = peelValueExpression(declaration.initializer);
    if (ts.isCallExpression(peeled)) {
        recordRequireDeclaration(declaration, peeled, scan);
        return;
    }
    recordAliasDeclaration(declaration, peeled, scan);
}
function recordVariableOrigins(node, scan) {
    for (const declaration of node.declarationList.declarations) {
        recordDeclarationOrigin(declaration, scan);
    }
}
function collectOrigins(node, scan) {
    if (ts.isImportDeclaration(node)) {
        recordImportOrigins(node, scan);
        return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
        recordImportEqualsOrigins(node, scan);
        return;
    }
    if (ts.isVariableStatement(node)) {
        recordVariableOrigins(node, scan);
    }
}
function pushExportTarget(scan, node, target) {
    scan.results.push({ target, pos: node.getStart(scan.sourceFile) });
}
function firstValueNamedExportTarget(elements, origins) {
    for (const element of elements) {
        if (element.isTypeOnly) {
            continue;
        }
        const localName = (element.propertyName !== undefined &&
            ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : undefined) ?? element.name.text;
        const target = origins.get(localName);
        if (target !== undefined) {
            return target;
        }
    }
    return undefined;
}
function recordModuleReexport(node, scan) {
    if (node.moduleSpecifier === undefined ||
        !ts.isStringLiteralLike(node.moduleSpecifier) ||
        !isValueReexport(node)) {
        return;
    }
    const target = scan.resolve(node.moduleSpecifier.text);
    if (target === undefined) {
        return;
    }
    pushExportTarget(scan, node, target);
}
function recordLocalExport(node, scan) {
    if (node.exportClause === undefined ||
        !ts.isNamedExports(node.exportClause) ||
        node.isTypeOnly) {
        return;
    }
    const target = firstValueNamedExportTarget(node.exportClause.elements, scan.origins);
    if (target === undefined) {
        return;
    }
    pushExportTarget(scan, node, target);
}
function recordExportDeclaration(node, scan) {
    if (node.moduleSpecifier !== undefined) {
        recordModuleReexport(node, scan);
        return;
    }
    recordLocalExport(node, scan);
}
function recordIdentifierExport(node, name, scan) {
    const target = scan.origins.get(name);
    if (target === undefined) {
        return;
    }
    pushExportTarget(scan, node, target);
}
function recordRequireExport(node, call, scan) {
    if (!isRealRequire(call, scan.requireIsCjs)) {
        return;
    }
    const specifier = stringLiteralText(call.arguments[0]);
    if (specifier === undefined) {
        return;
    }
    const target = scan.resolve(specifier);
    if (target === undefined) {
        return;
    }
    pushExportTarget(scan, node, target);
}
function recordExportAssignment(node, scan) {
    const peeled = peelValueExpression(node.expression);
    if (ts.isIdentifier(peeled)) {
        recordIdentifierExport(node, peeled.text, scan);
        return;
    }
    if (ts.isCallExpression(peeled)) {
        recordRequireExport(node, peeled, scan);
    }
}
function recordExportedImportEquals(node, scan) {
    if (!ts.isImportEqualsDeclaration(node) || !ts.isIdentifier(node.name)) {
        return;
    }
    const target = scan.origins.get(node.name.text);
    if (target === undefined) {
        return;
    }
    pushExportTarget(scan, node, target);
}
function recordExportedVariable(node, scan) {
    if (!ts.isVariableStatement(node)) {
        return;
    }
    for (const declaration of node.declarationList.declarations) {
        const target = originFromBindingName(declaration.name, scan.origins);
        if (target === undefined) {
            continue;
        }
        pushExportTarget(scan, node, target);
        return;
    }
}
function checkExports(node, scan) {
    if (ts.isExportDeclaration(node)) {
        recordExportDeclaration(node, scan);
        return;
    }
    if (ts.isExportAssignment(node)) {
        recordExportAssignment(node, scan);
        return;
    }
    if (hasExportModifier(node)) {
        recordExportedImportEquals(node, scan);
        recordExportedVariable(node, scan);
    }
}
export function namedDoorReexports(filePath, graph, content) {
    if (!isNamedDoor(filePath)) {
        return [];
    }
    const source = typeof content === "string" ? content : safeReadFile(filePath);
    if (source === undefined) {
        return [];
    }
    const sourceFile = parseSourceFile(filePath, source);
    const settings = getGraphResolutionSettings(graph);
    const fromDir = path.dirname(filePath);
    const results = [];
    const origins = new Map();
    const resolveInGraph = (specifier) => {
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
    const requireIsCjs = !scopeBindsRequire(sourceFile);
    const scan = {
        resolve: resolveInGraph,
        origins,
        results,
        sourceFile,
        requireIsCjs,
    };
    for (const statement of sourceFile.statements) {
        collectOrigins(statement, scan);
    }
    for (const statement of sourceFile.statements) {
        checkExports(statement, scan);
    }
    return results;
}
