import ts from "typescript";
/**
 * One policy, two ASTs.
 *
 * `require` is only an import edge when the name really is Node's CJS require: a
 * local binding shadows it, and EVERY def of that binding must be
 * `createRequire(...)` for the name to still be the real thing. There are
 * necessarily two implementations of that one rule, because the two callers hold
 * incompatible ASTs and neither can borrow the other's: `parse.ts` answers it
 * over a bare TypeScript `SourceFile` (no binder, no program, no scope manager)
 * for every file in the tree, while `rules/entry.ts` answers it over ESLint's
 * scope manager for the one file being linted, and must report on a positioned
 * node. Keeping both in this one file is what stops them drifting apart
 * silently. They already have: see AGENTS.md's Known issues for the binders the
 * TypeScript-side walk cannot see.
 */
// Both spellings count as the constructor: `createRequire(...)` and
// `mod.createRequire(...)`.
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
/**
 * Whether this TypeScript scope itself binds `require`, shadowing the CJS one.
 * Answered from a bare `ts.SourceFile`, so only the binders visible in the
 * syntax tree count.
 */
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
    for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!bindsName(declaration.name, REQUIRE)) {
                    continue;
                }
                // `const require = createRequire(import.meta.url)` IS the real require,
                // so its calls are genuine edges.
                if (tsIsCreateRequireCall(declaration.initializer)) {
                    continue;
                }
                return true;
            }
        }
        if (ts.isFunctionDeclaration(statement) &&
            statement.name?.text === REQUIRE) {
            return true;
        }
    }
    return false;
}
/**
 * The same question over ESLint's scope chain, which resolves it properly: a
 * `require` bound in an enclosing scope is not the CJS one, so it is not an edge
 * - unless it was bound by createRequire, which is.
 */
export function requireIsShadowed(sourceCode, node) {
    let scope = sourceCode.getScope(node);
    while (scope !== null) {
        const variable = scope.variables.find((entry) => entry.name === REQUIRE);
        // An ambient/global `require` (Node's CJS globals, a `.cjs` file's
        // default sourceType, `globals: globals.node`) has no defs at all - it
        // is not a local binding, so it must not be treated as shadowing the
        // CJS one. Only a variable with an actual definition here (parameter,
        // `const`, `function require() {}`, ...) can shadow it.
        if (variable !== undefined && variable.defs.length > 0) {
            // Every def has to be a createRequire binding for the name to still be
            // the real require. `defs.some` was order-blind: with `var require =
            // createRequire(url)` followed by `var require = 1`, the call loads
            // nothing at all, yet a some() check still called it genuine and
            // reported a crossing that cannot happen. Requiring all of them trades
            // that false positive for a false negative in the mirror case (plain
            // first, createRequire second) - the right way round for a lint rule,
            // and just as rare, since both need `require` declared twice in one
            // scope.
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
