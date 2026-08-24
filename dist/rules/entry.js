import path from "node:path";
import { safeRealpath } from "../lib/fs-safe.js";
import { findCrossedGate } from "../lib/gates.js";
import { canonicalGraphPath, getGraph, getGraphResolutionSettings, isExcludedPath, isOutsideRoot, isSourceFile, isTestFile, resolveSpecifier, } from "../lib/graph.js";
import { resolveRootDir } from "../lib/root.js";
function relativePosix(from, to) {
    return path.relative(from, to).split(path.sep).join("/");
}
// Mirrors graph.ts's isCreateRequireCall: accepts both `createRequire(...)`
// and `mod.createRequire(...)`.
function isCreateRequireCall(init) {
    if (init === null || init === undefined || init.type !== "CallExpression") {
        return false;
    }
    const callee = init.callee;
    return ((callee.type === "Identifier" && callee.name === "createRequire") ||
        (callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "createRequire"));
}
// Mirrors graph.ts: a `require` bound in an enclosing scope is not the CJS one,
// so it is not an edge - unless it was bound by createRequire, which is.
function requireIsShadowed(sourceCode, node) {
    let scope = sourceCode.getScope(node);
    while (scope !== null) {
        const variable = scope.variables.find((entry) => entry.name === "require");
        // An ambient/global `require` (Node's CJS globals, a `.cjs` file's
        // default sourceType, `globals: globals.node`) has no defs at all - it
        // is not a local binding, so it must not be treated as shadowing the
        // CJS one. Only a variable with an actual definition here (parameter,
        // `const`, `function require() {}`, ...) can shadow it.
        if (variable !== undefined && variable.defs.length > 0) {
            return !variable.defs.some((def) => {
                const declarator = def.node;
                return (declarator.type === "VariableDeclarator" &&
                    isCreateRequireCall(declarator.init));
            });
        }
        scope = scope.upper;
    }
    return false;
}
const rule = {
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
            reachesPastEntry: "'{{target}}' is inside module '{{module}}'; import it through '{{entry}}', or move it out of '{{module}}' if it is not part of it.",
        },
    },
    create(context) {
        const options = (context.options[0] ?? {});
        const rootOption = options.root ?? ".";
        const ignore = options.ignore ?? [];
        if (!isSourceFile(context.filename)) {
            return {};
        }
        // Resolved eagerly but tolerantly: a root that is not on disk, or a linted
        // path that is not a real file (processors, --stdin-filename, deleted
        // mid-run), means "nothing to say" rather than a crash.
        const rootDir = resolveRootDir(rootOption, context.cwd);
        const realRootDir = safeRealpath(rootDir);
        const realFilename = safeRealpath(context.filename);
        if (realRootDir === undefined || realFilename === undefined) {
            return {};
        }
        const relPath = path.relative(realRootDir, realFilename);
        if (isOutsideRoot(relPath) ||
            isTestFile(relPath) ||
            isExcludedPath(relPath, ignore)) {
            return {};
        }
        const fromDir = path.dirname(realFilename);
        // Lazy: measured against eager on a tree where most files import
        // nothing, lazy comes out meaningfully cheaper per file (getGraph is a
        // cache lookup, not a free one, so a file that never calls
        // reportIfPastEntry should not pay for it). context.sourceCode still lets
        // ownership and entry share one graph build per file when both fire on
        // it - see the comment on CachedGraph.lastToken in graph.ts for why a
        // bare file-path repeat cannot be trusted for that, and getGraph's own
        // visitToken short-circuit for why this composes correctly regardless of
        // which rule asks first or whether either is lazy.
        let graph;
        let settings;
        const reportIfPastEntry = (specifier, node) => {
            graph ??= getGraph(rootDir, ignore, realFilename, context.sourceCode);
            settings ??= getGraphResolutionSettings(graph, rootDir);
            const resolved = resolveSpecifier(specifier, fromDir, settings);
            if (resolved === undefined) {
                return;
            }
            // fs.realpathSync does not fold case on macOS, so a resolved path carries
            // the specifier's casing. Left uncorrected, "./Feature/FEATURE" misses
            // isEntryFile and reports a door the author already used, while
            // "./feature/helper" misses the gate key and reports nothing at all.
            const target = canonicalGraphPath(graph, resolved);
            const targetRel = path.relative(realRootDir, target);
            if (isOutsideRoot(targetRel) ||
                isTestFile(targetRel) ||
                isExcludedPath(targetRel, ignore)) {
                return;
            }
            const crossed = findCrossedGate(target, realFilename, graph, realRootDir);
            if (crossed === undefined) {
                return;
            }
            context.report({
                node,
                messageId: "reachesPastEntry",
                data: {
                    target: relativePosix(realRootDir, target),
                    module: relativePosix(realRootDir, crossed.dir),
                    entry: relativePosix(realRootDir, crossed.entry),
                },
            });
        };
        const checkSource = (source) => {
            if (source === null ||
                source === undefined ||
                source.type !== "Literal" ||
                typeof source.value !== "string") {
                return;
            }
            reportIfPastEntry(source.value, source);
        };
        return {
            ImportDeclaration(node) {
                checkSource(node.source);
            },
            // No barrel exemption here, unlike ownership's namespace-barrel
            // handling: that exemption is about where a file belongs, not about
            // whether reaching through it is legal. A barrel that re-exports a
            // private file under a public name launders the violation - every
            // downstream consumer of the barrel then looks innocent - so `export
            // ... from` is checked exactly like an import. (ownership's predicate
            // is sibling-scoped, so it would not even recognise a cross-directory
            // barrel like this one.)
            ExportNamedDeclaration(node) {
                checkSource(node.source);
            },
            ExportAllDeclaration(node) {
                checkSource(node.source);
            },
            ImportExpression(node) {
                checkSource(node.source);
            },
            // Not an ESTree node, so it arrives untyped from the TypeScript parser -
            // `unknown` is honest about that, and RuleListener's index signature
            // accepts any parameter annotation here contravariantly.
            TSImportEqualsDeclaration(node) {
                const reference = node.moduleReference;
                if (reference.type === "TSExternalModuleReference") {
                    checkSource(reference.expression);
                }
            },
            CallExpression(node) {
                if (node.callee.type !== "Identifier" ||
                    node.callee.name !== "require" ||
                    // graph.ts takes arguments[0] at any arity, so require("./x", opts)
                    // is still an edge there; narrowed to exactly one argument here
                    // deliberately, since a real CJS require never takes a second one.
                    node.arguments.length !== 1) {
                    return;
                }
                if (requireIsShadowed(context.sourceCode, node)) {
                    return;
                }
                checkSource(node.arguments[0]);
            },
        };
    },
};
export default rule;
