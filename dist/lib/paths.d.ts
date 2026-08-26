/**
 * Whether `filePath` sits strictly inside `dir`.
 *
 * One home for a predicate that previously existed in three copies - in
 * `gates.ts`, `owners.ts`, and as `isWithinRoot` in `graph.ts` - each carrying
 * the same defect: appending a separator to a `dir` that already ends in one
 * builds `"//"`, which matches nothing, so a file plainly inside the directory
 * looked outside it. That is reachable rather than theoretical, because
 * `resolveRootDir` returns an absolute `root` verbatim and so `root: "/"`
 * survives all the way down here. Fixing one copy left the other two wrong; the
 * point of this module is that there is nowhere left for them to disagree.
 *
 * Lives on its own rather than in `graph.ts` so that `gates.ts` can use it
 * without the access model depending on the graph or the ownership model, which
 * is what the duplication was originally protecting.
 */
export declare function isInsideDir(filePath: string, dir: string): boolean;
/** `isInsideDir`, but a directory also counts as being at itself. */
export declare function isAtOrInsideDir(filePath: string, dir: string): boolean;
