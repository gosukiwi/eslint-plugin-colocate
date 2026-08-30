import type { Graph } from "./graph.js";
import type { Subject } from "./subject.js";
export interface SingletonDirectoryStats {
    sourceCount: number;
    hasStylesheet: boolean;
}
export type OwnershipFinding = "singletonFolder" | "privateOutsideOwner" | "sharedTooHigh" | "sharedInsideOwner";
export declare function singletonDirectoryStats(dir: string, rootDir: string, ignore: string[], graph: Graph): SingletonDirectoryStats;
export declare function ownershipFindings(subject: Subject, cwd: string, layers: string[]): OwnershipFinding[];
