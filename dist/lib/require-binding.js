import ts from "typescript";
const CREATE_REQUIRE = "createRequire";
const REQUIRE = "require";
function tsIsCreateRequireCall(node) {
    if (node === undefined || !ts.isCallExpression(node)) {
        return false;
    }
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
        return callee.text === CREATE_REQUIRE;
    }
    return (ts.isPropertyAccessExpression(callee) && callee.name.text === CREATE_REQUIRE);
}
function estreeIsCreateRequireCall(init) {
    if (init === null || init === undefined || init.type !== "CallExpression") {
        return false;
    }
    const callee = init.callee;
    return ((callee.type === "Identifier" && callee.name === CREATE_REQUIRE) ||
        (callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            callee.property.name === CREATE_REQUIRE));
}
function bindsName(name, target) {
    if (ts.isIdentifier(name)) {
        return name.text === target;
    }
    return name.elements.some((element) => ts.isBindingElement(element) ? bindsName(element.name, target) : false);
}
function declarationBindsRequire(declaration) {
    if (!bindsName(declaration.name, REQUIRE)) {
        return false;
    }
    return !tsIsCreateRequireCall(declaration.initializer);
}
function statementBindsRequire(statement) {
    if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.some(declarationBindsRequire);
    }
    return (ts.isFunctionDeclaration(statement) && statement.name?.text === REQUIRE);
}
export function scopeBindsRequire(node) {
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
    return statements.some(statementBindsRequire);
}
export function requireIsShadowed(sourceCode, node) {
    let scope = sourceCode.getScope(node);
    while (scope !== null) {
        const variable = scope.variables.find((entry) => entry.name === REQUIRE);
        if (variable !== undefined && variable.defs.length > 0) {
            return !variable.defs.every((def) => {
                const declarator = def.node;
                return (declarator.type === "VariableDeclarator" &&
                    estreeIsCreateRequireCall(declarator.init));
            });
        }
        scope = scope.upper;
    }
    return false;
}
