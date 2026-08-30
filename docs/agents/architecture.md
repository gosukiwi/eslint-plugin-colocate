# Architecture

Peer: `eslint >= 9`. Developed against ESLint 10. TypeScript is both a runtime dependency (compiler API for parse/resolve) and a devDependency.

## Layout

```
src/index.ts              plugin export: meta + rules.ownership, rules.entry
src/rules/ownership.ts    ESLint rule: options, messages, one report per finding
src/rules/entry.ts        ESLint rule: import-boundary reports
src/lib/scope.ts          what is in the model: source/test/ignore/skip predicates
src/lib/subject.ts        the linted file, once it is known to be in the model
src/lib/walk.ts           the tree walk: every source file under a root
src/lib/parse.ts          TypeScript parse + import-specifier extraction
src/lib/require-binding.ts is this `require` the CJS one — both ASTs, one policy
src/lib/resolve.ts        tsconfig load, `paths` aliasing, specifier resolution
src/lib/graph.ts          Graph, build, membership, path canonicalisation
src/lib/graph-cache.ts    one graph per process, revalidated once per lint pass
src/lib/gates.ts          entry detection, gate map, crossed-gate lookup
src/lib/owners.ts         owners, shells, layers, colocation
src/lib/findings.ts       what `ownership` reports, in report order
src/lib/paths.ts          is-this-path-inside-that-directory, one copy only
src/lib/derived.ts        index derived from a graph, memoised for its lifetime
src/lib/root.ts           resolve a configured root from any working directory
src/lib/fs-safe.ts        every filesystem read: degrade to skip, never throw
tests/fixtures/<name>/    one layout per scenario
tests/helpers/lint-fixture.ts
scripts/check-placement.ts  opt-in satisfiability sweep, both rules
```

## Derived indexes

Every per-graph derived index — resolution settings, the member and folded-path indexes, files-by-directory, gates, shells, layer directories — goes through `derivedFromGraph` in `src/lib/derived.ts`: do not hand-roll another `WeakMap<Graph, X>`, and do not hang feature state on `Graph` (it is `readonly` precisely so those indexes can be trusted for the graph's lifetime). Membership is one of those indexes: ask `graphHasFile` from `graph.ts`, never `new Set(graph.files)` per lint. Files in a directory are another: ask `graphFilesInDir`, never `graph.files.filter` by dirname.

## Rule adapters

Neither rule file holds model logic; both read as adapters between ESLint and a module that can be asked without one. `entry.ts` asks `gates.ts`. `ownership.ts` asks `ownershipFindings` in `src/lib/findings.ts`, which composes `owners.ts`'s graph predicates with the one question nothing else asks — is this directory a singleton wrapper (a `readdir` walk that never touches the graph) — and returns the messageIds **in report order**. That split is why `findings.ts` is not part of `owners.ts`: `owners.ts` answers "who owns this file" from the import graph and is consumed by several callers, while `findings.ts` is the one rule's report set.

Reports are emitted on `node.body[0] ?? node` so file-level `eslint-disable` still applies under ESLint 10 (Program-node reports are dropped there). Cover this with both `@typescript-eslint/parser` and Espree (`eslint-disable-ownership`, `eslint-disable-ownership-js`).

## Version and docs URLs

`plugin.meta.version` is hardcoded in `src/index.ts`. `tests/plugin-meta.test.ts` asserts it matches `package.json` — bump both.

Rule docs URLs point at `#what-it-reports` (`ownership`) and `#the-entry-rule` (`entry`), both on `https://github.com/gosukiwi/eslint-plugin-colocate`. Keep headings in the README that GitHub slugifies to exactly those anchors — nothing catches a dangling one: `plugin-meta.test.ts` only asserts each URL starts with `https://`.

## Scope and subject

"Is this path in the model" is `isInGraphScope` in `src/lib/scope.ts` and nowhere else; it was inline in four places before. The rule-side preamble around it — default the root, `resolveRootDir`, realpath root and file, tolerate either being absent, reject an out-of-scope file — is `resolveSubject` in `src/lib/subject.ts` and nowhere else. Use `subject.covers` for a resolved target rather than rebuilding the disjunction.

Two asymmetries inside `Subject` are load-bearing and must survive any tidying. `rootDir` is resolved but **not** realpathed, because it is half the graph cache key. The linted file is scope-tested but not extension-tested again after realpath, so a `.ts` symlink pointing at a `.txt` file is still a subject, whereas resolved targets *are* extension-tested.

`isInsideDir` has **exactly one** implementation, `src/lib/paths.ts`, used by `gates.ts`, `owners.ts` and (as `isAtOrInsideDir`) `walk.ts`. It once existed in three copies sharing one defect — appending a separator to a `dir` that already ends in one builds `"//"` and matches nothing, so with `root: "/"` a file plainly inside a directory looked outside it. Fixing one copy left the other two wrong. Do not reintroduce a local copy.
