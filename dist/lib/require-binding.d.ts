import type { SourceCode } from "eslint";
import type * as ESTree from "estree";
import ts from "typescript";
export declare function scopeBindsRequire(node: ts.Node): boolean;
export declare function requireIsShadowed(sourceCode: SourceCode, node: ESTree.Node): boolean;
