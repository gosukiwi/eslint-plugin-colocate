import type { Rule } from "eslint";
import type { Graph } from "./graph.js";
export interface Subject {
    readonly rootDir: string;
    readonly realRootDir: string;
    readonly file: string;
    readonly lintedPath: string;
    readonly ignore: string[];
    graph(): Graph;
    covers(filePath: string): boolean;
    display(filePath: string): string;
}
export declare function resolveSubject(context: Rule.RuleContext): Subject | undefined;
