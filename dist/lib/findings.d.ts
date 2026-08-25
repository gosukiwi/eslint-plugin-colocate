import type { Subject } from "./subject.js";
/**
 * Everything `colocate/ownership` can say about a file.
 *
 * The two decisions below - is this directory a singleton wrapper, is this index
 * a stand-in for one sibling - lived in the rule until they were moved here, for
 * the reason `gates.ts` exists: a rule file should read as an adapter between
 * ESLint and a model, and the model should be answerable (and testable) without
 * one. `owners.ts` holds the predicates that answer "who owns this file" from the
 * import graph; this module holds what the rule *reports* and in which order,
 * plus the two questions no other caller asks - one of which is a directory walk
 * that never touches the graph at all.
 */
export type OwnershipFinding = "singletonFolder" | "privateOutsideOwner" | "sharedTooHigh" | "sharedInsideOwner" | "mismatchedEntry";
/**
 * Every finding for this file, **in report order**.
 *
 * The order is part of the contract, not an accident of how this reads: the
 * fixture assertions sort, but `check:placement` prints a per-placement matrix of
 * raw sequences and the differential compares raw output, so reordering these
 * four pushes would show up as a diff with no behaviour behind it.
 *
 * Nothing here short-circuits, again deliberately: a file can be a singleton
 * wrapper *and* misplaced relative to its owner, and each report names a
 * different edit.
 */
export declare function ownershipFindings(subject: Subject, cwd: string, layers: string[]): OwnershipFinding[];
