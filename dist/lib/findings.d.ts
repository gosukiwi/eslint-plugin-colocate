import type { Subject } from "./subject.js";
export type OwnershipFinding = "singletonFolder" | "privateOutsideOwner" | "sharedTooHigh" | "sharedInsideOwner";
export declare function ownershipFindings(subject: Subject, cwd: string, layers: string[]): OwnershipFinding[];
