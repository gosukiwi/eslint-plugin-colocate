import type { SourceCode } from "eslint";
import type * as ESTree from "estree";
import ts from "typescript";
/**
 * Whether this TypeScript scope itself binds `require`, shadowing the CJS one.
 * Answered from a bare `ts.SourceFile`, so only the binders visible in the
 * syntax tree count.
 */
export declare function scopeBindsRequire(node: ts.Node): boolean;
/**
 * The same question over ESLint's scope chain, which resolves it properly: a
 * `require` bound in an enclosing scope is not the CJS one, so it is not an edge
 * - unless it was bound by createRequire, which is.
 */
export declare function requireIsShadowed(sourceCode: SourceCode, node: ESTree.Node): boolean;
