import { type Graph } from "./graph.js";
export type VisitToken = object;
export declare const REVALIDATE_AFTER_MS = 100;
export declare function stampIsAmbiguous(mtimeMs: number, builtAt: number, coarseTimestamps: boolean, stampedAt?: number): boolean;
export declare function getGraph(rootDir: string, ignoreGlobs: string[], currentFile: string, visitToken?: VisitToken): Graph;
