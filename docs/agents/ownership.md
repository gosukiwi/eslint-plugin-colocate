# Ownership model

The graph asks, for each file: who depends on me, and does my location reflect that?

**Owner.** Walk up from a file. A directory is an owner if it contains an **entry file**: named after the directory (`pages/MyPage/MyPage.ts`), or an `index` that **code outside the directory** imports through. A barrel that only groups loose helpers is not an owner — treating it as one redraws every boundary around it. No such folder → the file owns only itself (`standalone`).

**Private.** Exactly one owner imports the file → it belongs inside that owner's folder (or, for a standalone owner, it *is* that file).

**Shared.** Two or more owners import it → it belongs at their closest common ancestor directory, not above it, and not inside an owner folder *below* that ancestor. Sitting inside a folder at or above the LCA is fine. A folder's own entry is never flagged for sitting in its own folder; if the *folder* is misplaced, folders above it report it.

**Shell.** Entry points (nothing imports them) plus what they import **directly** are shell: they do not own what they import. `main.ts → App.ts → pages/Home/Home.ts` leaves `Home` alone with no config. Entry points are detected per strongly connected component (iterative Tarjan), so `main ↔ App` or a self-import still yields a shell.

Shell exemption is **not transitive** and **not configurable**. There is no `shells` option (it was removed). Longer bootstrap (`main → router → App → pages/...`) is expressed with `layers`. Do not add a wholesale shell-import exemption: it would hide a shell reaching past a feature entry into internals (`shell-reaches-internals` fixture).

**Skip colocation** when the file itself is shell, is a layer public module, or has no non-shell / non-namespace-barrel consumers.

**Namespace barrels.** An `index` that re-exports two or more local siblings is not a consumer of what it re-exports. An `index` that re-exports exactly one sibling *is* a consumer.

Prefer extending a fixture over adding options. Options exist for things the graph cannot infer (`layers`, generated files). After changing owners, shells, layers, barrels, or what counts as a consumer, run `npm run check:placement`.

Layers as configuration: [options](options.md). What ownership reports: below. How `findings.ts` relates to `owners.ts`: [architecture](architecture.md).

## Reports

Report **order** for one file is `singletonFolder`, `privateOutsideOwner`, the shared issue, `mismatchedEntry` — the order `ownershipFindings` pushes them in. Exactly one test pins it: `two-findings-one-file` in `ownership.test.ts`, asserted **unsorted**. Every other assertion in that file sorts first, and `check:placement` does **not** catch a reordering — it builds a per-placement matrix but only prints it when a configuration has no clean placement at all, so swapping two pushes leaves the suite green, typecheck clean and `unsatisfiable=0`. Verified by mutation. Do not delete that fixture or sort its assertion. Nothing short-circuits: a file can be a singleton wrapper *and* misplaced relative to its owner, and each report names a different edit.

| messageId | when |
| --- | --- |
| `privateOutsideOwner` | one owner, file sits outside that folder |
| `sharedTooHigh` | several owners, file sits above their LCA |
| `sharedInsideOwner` | several owners, file sits inside an owner folder below the LCA (including a non-consumer owner that merely surrounds it) |
| `singletonFolder` | directory holds one source file, no companion stylesheet beside it, and the file is named after the directory or `index`. Not reported on `root` itself. Source count is recursive; stylesheets are **same directory only** (`.css` `.scss` `.sass` `.less` `.styl`). Tests, `dist`, ignored files do not count as a second source. |
| `mismatchedEntry` | `index` re-exports exactly one sibling under a different name, and outside code imports the barrel |

`mismatchedEntry` is narrow. Leave alone: index re-exporting the named entry (`Foo/index.ts` → `Foo/Foo.ts`); aggregator that also re-exports elsewhere (including an unresolvable specifier); self-reexport; index in `root`; nothing outside imports it; sibling excluded by `ignore`. Value+type split of the same module (`export { x }` + `export type { T }` from `./X`) is still **one** sibling. Both counts — the siblings and the aggregated total — are per resolved **module**, so *any* two spellings of one module count once, not just the value+type split: `./X` and `./X.js`, `./X` and an aliased `@/dir/X`, and on a case-insensitive disk `./X` and `./x`. Only a specifier that does not resolve is counted by its text, which is what keeps an unresolvable re-export an aggregator. The same folding cuts the other way for a **self** re-export: `export * from "./INDEX"` inside `index.ts` on a case-insensitive disk is now recognised as the self-reexport it is and dropped, where it used to count as both a second module and a local sibling — so a barrel that was silent on that input now reports.

Every report must be **fixable**: for `ownership` there has to exist a location the rule accepts, and for `entry` a specifier the importer can use. `check:placement` guards both — it sweeps `entry` by checking that no report names a module the importer already lives inside, since then the only "fix" would be importing its own door.
