# AGENTS.md

Guidance for agents working on this repository. Consumer-facing usage lives in `README.md`.

## What this is

ESLint 9+ plugin with two rules over the same import graph. `colocate/ownership` walks a source tree and reports files whose **location** does not match **who depends on them**. `colocate/entry` reports **imports** that reach past a module's entry file into its internals. ESM only, Node 20+, TypeScript with `module: NodeNext`. Tests import `src/` directly; `npm run build` emits `dist/` for the published package.

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

`plugin.meta.version` is hardcoded in `src/index.ts`. `tests/plugin-meta.test.ts` asserts it matches `package.json` — bump both.

Every per-graph derived index — resolution settings, the member and folded-path indexes, gates, shells, layer directories — goes through `derivedFromGraph` in `src/lib/derived.ts`: do not hand-roll another `WeakMap<Graph, X>`, and do not hang feature state on `Graph` (it is `readonly` precisely so those indexes can be trusted for the graph's lifetime). Membership is one of those indexes: ask `graphHasFile` from `graph.ts`, never `new Set(graph.files)` per lint.

Neither rule file holds model logic; both read as adapters between ESLint and a module that can be asked without one. `entry.ts` asks `gates.ts`. `ownership.ts` asks `ownershipFindings` in `src/lib/findings.ts`, which composes `owners.ts`'s graph predicates with the two questions nothing else asks — is this directory a singleton wrapper (a `readdir` walk that never touches the graph) and is this index a stand-in for one sibling — and returns the messageIds **in report order**. That split is why `findings.ts` is not part of `owners.ts`: `owners.ts` answers "who owns this file" from the import graph and is consumed by several callers, while `findings.ts` is the one rule's report set.

Rule docs URLs point at `#what-it-reports` (`ownership`) and `#the-entry-rule` (`entry`), both on `https://github.com/gosukiwi/eslint-plugin-colocate`. Keep headings in the README that GitHub slugifies to exactly those anchors — nothing catches a dangling one: `plugin-meta.test.ts` only asserts each URL starts with `https://`.

## Commands

```bash
npm test                 # vitest run — the gate
npm run typecheck
npm run build
npm run check:placement  # not part of npm test; run after ownership-model changes
CONFIGS=40 npm run check:placement   # quicker pass
SEED=<n> npm run check:placement     # reproduce a sweep
```

## Ownership model

The graph asks, for each file: who depends on me, and does my location reflect that?

**Owner.** Walk up from a file. A directory is an owner if it contains an **entry file**: named after the directory (`pages/MyPage/MyPage.ts`), or an `index` that **code outside the directory** imports through. A barrel that only groups loose helpers is not an owner — treating it as one redraws every boundary around it. No such folder → the file owns only itself (`standalone`).

**Private.** Exactly one owner imports the file → it belongs inside that owner's folder (or, for a standalone owner, it *is* that file).

**Shared.** Two or more owners import it → it belongs at their closest common ancestor directory, not above it, and not inside an owner folder *below* that ancestor. Sitting inside a folder at or above the LCA is fine. A folder's own entry is never flagged for sitting in its own folder; if the *folder* is misplaced, folders above it report it.

**Shell.** Entry points (nothing imports them) plus what they import **directly** are shell: they do not own what they import. `main.ts → App.ts → pages/Home/Home.ts` leaves `Home` alone with no config. Entry points are detected per strongly connected component (iterative Tarjan), so `main ↔ App` or a self-import still yields a shell.

Shell exemption is **not transitive** and **not configurable**. There is no `shells` option (it was removed). Longer bootstrap (`main → router → App → pages/...`) is expressed with `layers`. Do not add a wholesale shell-import exemption: it would hide a shell reaching past a feature entry into internals (`shell-reaches-internals` fixture).

**Skip colocation** when the file itself is shell, is a layer public module, or has no non-shell / non-namespace-barrel consumers.

**Namespace barrels.** An `index` that re-exports two or more local siblings is not a consumer of what it re-exports. An `index` that re-exports exactly one sibling *is* a consumer.

## Entry model (`colocate/entry`)

Separate rule, separate concept. `ownership` asks where a file belongs; `entry` asks whether an import may cross into a module.

**Gate.** A directory containing an entry file: named after the directory, or `index`. Detection is **structural** — unlike `isOwnerEntryFile`, nothing has to import it. That difference is deliberate: the imported-through condition exists to stop a convenience barrel from redrawing *ownership* boundaries, and a door that gated nothing until consumers had already migrated would never engage.

**Illegal** ⟺ the target is not an entry file **and** some gate contains the target but not the importer. Report on the specifier node, naming the **innermost** such gate (`index` wins when a directory has two doors).

**Nested doors count.** Landing on any entry is legal, including a child module's. This is what makes innermost the right gate to name: any door is a legal terminus, so one report is always one edit, with no cascade.

Options are `{ root, ignore }` only. Do not add `layers` — placement and access are different questions, and conflating them is what the design explicitly rejected.

Invariants: no shell exemption (that is the point of the rule); no barrel exemption for importers, unlike `getColocationConsumers`; type-only imports treated like value imports, in both the `import type { T } from "./x"` and the inline `import("./x").T` / `typeof import("./x")` spellings (`TSImportType`, a separate visitor); no autofix; no check on whether the door re-exports the symbol; never a requirement that a directory *have* an entry.

Specifiers must be **statically known**: a quoted string or a template literal with no substitutions. Backticks resolve exactly as quotes do, so leaving them out of `entry` made them a one-character way to launder every crossing past a ratchet rule. The `cooked` value is what gets resolved, not `raw`. Anything else (a substituted template, concatenation, `as string`, an identifier) stays out. **`parse.ts` has not been given the same treatment** — see Known issues — so backticks still launder an `ownership` finding. Declaration files are outside the model as **targets** as well as doors — `resolveSpecifier`'s probe still finds `types.d.ts` for a `"./types.d"` specifier, so the target is filtered on `isSourceFile`.

The `TSImportType` visitor must read **both** AST shapes: `node.source` exists only from `@typescript-eslint/parser` 8.48, and before that the specifier sits on `node.argument.literal` (a `TSLiteralType`). This plugin declares no parser dependency, so reading `source` alone leaves the visitor silently inert on every 8.x below 8.48 a user may install — inert in exactly the way the visitor was added to fix, and invisible from the outside.

Both the target *and* the importer must be passed through `canonicalGraphPath` before reaching `findCrossedGate`. `realpath` does not fold case, so a wrong-case linted path made `isInsideDir` miss and reported a file for reaching into the directory it lives in — a report whose only fix is a cycle through its own door. Contrast a wrong-case **root**, which is documented below to produce *no* findings.

`entry`'s `CallExpression` visitor narrows to a single-argument `require()`, unlike `parse.ts`, which takes `arguments[0]` at any arity — a real CJS `require` never takes a second argument. Note that this argument cuts the other way too: it is `parse.ts` that should narrow, and until it does, a two-argument `require()` creates a graph edge and so a possible `ownership` report that `entry` will not corroborate. See Known issues.

`requireIsShadowed` requires **every** def of a `require` binding to be a `createRequire` call before treating it as the real require. Asking whether *any* def was one is order-blind: `var require = createRequire(url)` followed by `var require = 1` leaves a number at the call site, so it loads nothing. The mirror case (plain first, `createRequire` second) is now a false negative — the right way round for a lint rule, and just as rare, since both need `require` declared twice in one scope.

## Known issues (deferred, do not fix without discussion)

Each bullet names the GitHub issue tracking it, or is marked **unfiled** (a real defect with no issue yet) or **by design** (a consequence or convention recorded here so it is not mistaken for a bug). Keep that mapping true: this section and the tracker are meant to agree, and an audit on 2026-08-25 found they had drifted.

**These are graph-pipeline bugs — `walk.ts`, `parse.ts`, `resolve.ts`, `graph.ts` — and the graph is the only surface `colocate/ownership` consumes.** `entry` computes its verdict from its own AST walk plus `graph.files` (gates never read `graph.importers`), so a bad `require` edge is invisible to `entry` and load-bearing for `ownership`. "The rule handles scope better than the graph does" is therefore *not* a reason any of these is harmless — each spurious edge is a potential wrong `ownership` report, and each missing edge a lost one. Reviewed 2026-08-25: all of the below were demonstrated to change `ownership` output, including one case that flips `sharedTooHigh` into `privateOutsideOwner` and silently drops a second file's report.

Note the corollary, because it has already caught two bullets in this list out: **do not assume a gate-model bug is `entry`-only.** `owners.ts`'s `isOwnerEntryFile` repeats the same `basename(file, extname(file)) === basename(dir)` comparison that `gates.ts`'s `isEntryFile` does, so anything that breaks the notion of "this file is its directory's entry" destroys the folder *owner* as well as the gate, and adds false `ownership` positives.

- `scopeBindsRequire` (`require-binding.ts`) only inspects `SourceFile` / `Block` / `ModuleBlock` statements plus function parameters, so **every other binder of the name `require` is invisible to it** (**#8**): a `catch` parameter, a `for`/`for-of` binding, a `switch` case declaration without a block, a named function *expression*, a class declaration, `var` hoisted out of a block, a default import named `require`, a labeled block. In each, `parse.ts` records an edge for a call that is not Node's `require` at all. `requireIsShadowed`, its scope-manager counterpart in the same file, asks ESLint and gets all of them right.
- `import { createRequire as require }` followed by `require("./x")` produces a spurious edge in `parse.ts` to `./x` (**#8**). That call returns a require function; it doesn't load `./x`.
- `parse.ts` propagates its `shadowed` flag stickily to all descendant scopes (**#8**), so an inner `const require = createRequire(...)` is ignored when an outer non-`createRequire` `require` exists somewhere above it. The rule's scope-chain walk is properly lexical and does not have this bug (pinned by `entry-require-inner-createrequire`).
- `parse.ts` takes `require`'s `arguments[0]` at any arity (**#8**), so `require("./x", opts)` is an edge there and not in `entry`.
- Neither surface sees a **type-position** `import()` inside `parse.ts`'s edge extraction (`ts.isCallExpression` does not match an `ImportTypeNode`) — **unfiled**. `entry` *does* gate it, as of the `TSImportType` visitor, so this is now a graph-only gap.
- `collectReExports` (`owners.ts`) never canonicalises case (**#10**), so on a case-insensitive disk a wrong-case re-export makes `mismatchedEntry` miss, and a value+type split written with mixed casing counts as **two** siblings — silently reclassifying the index as a namespace barrel and contradicting the "still one sibling" rule below.
- `collectReExports` also calls `resolveSpecifier` **without the graph's `ResolutionSettings`** (**#14**), so it has no `paths` and no `baseUrl` and every aliased re-export resolves to nothing. That is the exact trap `graph.ts` documents for `getGraphResolutionSettings`. It costs a `mismatchedEntry` *and* inverts namespace-barrel classification, which feeds `getColocationConsumers` — so one alias can move ownership findings for unrelated files. Both this and the casing bug want `collectReExports` to be handed the graph, so fix them together.
- `isNamespaceBarrel` re-reads and re-parses every barrel for every subject, unmemoised (**#15**) — reads scale with barrels × shared files. Performance only; `derivedFromGraph` is the natural home for the memo.
- `stringLiteralText` (`parse.ts`) uses `ts.isStringLiteral`, which is false for a no-substitution template literal (`ts.isStringLiteralLike` is the one that matches) — **#9**. So `require(\`../helper\`)` and `` import(`../helper`) `` produce **no graph edge**, and one backtick silently erases a real `privateOutsideOwner`. `entry` gates both spellings; `ownership` does not.
- **By design**, recorded so it is not mistaken for a bug: `isInsideDir` now has exactly one implementation, in `src/lib/paths.ts`, used by `gates.ts`, `owners.ts`, and (as `isAtOrInsideDir`) `walk.ts`. It previously existed in three copies sharing one defect: appending a separator to a `dir` that already ends in one builds `"//"` and matches nothing, so with `root: "/"` a file plainly inside a directory looked outside it. Do not reintroduce a local copy — that is how fixing one left the other two wrong.
- **By design:** "Is this path in the model" is `isInGraphScope` in `src/lib/scope.ts` and nowhere else — the `isOutsideRoot`/`isTestFile`/`isExcludedPath` disjunction previously sat inline in four places (`graph-cache.ts`, `ownership.ts`, and twice in `entry.ts`). The rule-side preamble around it — default the root, `resolveRootDir`, realpath root and file, tolerate either being absent, reject an out-of-scope file — is `resolveSubject` in `src/lib/subject.ts` and nowhere else. Do not reintroduce a local copy of either; use `subject.covers` for a resolved target. Two asymmetries inside `Subject` are load-bearing: `rootDir` is resolved but **not** realpathed because it is half the graph cache key, and the linted file is scope-tested but not extension-tested again after realpath (so a `.ts` symlink pointing at a `.txt` file is still a subject), whereas resolved targets are. A third is merely preserved: `Subject.lintedPath` is the un-realpathed path, and `mismatchedEntry` asks "is this an index?" of *it* while every other check uses the realpathed `file`, so a symlink named `index.ts` pointing at a differently-named module is an index for that one decision only. That has always been the behaviour; do not use `lintedPath` for anything else, and settle the inconsistency deliberately if you touch it.
- **Unicode normalization** is folded by `canonicalGraphPath`, on every platform, because it is independent of whether the filesystem ignores case: `readdir` reports the stored form while a specifier carries whatever the author's editor wrote, and neither `realpath` nor the resolver converts between them. The builder's own edge-recovery index in `graph.ts` is still keyed on lower case alone, so `ownership` remains NFC/NFD-blind (**#16**) — a specifier spelling `Café/` in NFD against an NFC directory silently drops the *edge*, and with it any ownership finding that depended on it. Fixing that would change `ownership` output by surfacing edges it currently misses.
- A **door that is a symlink** to another in-root file dissolves its gate (**#13**): `walkDir` records real paths, so `Feature/Feature.ts -> ../shared/impl.ts` leaves `Feature` with no entry and legalises every reach past it. Same inversion as ignoring a door, from a different cause. **Not `entry`-only** — it also removes the folder owner, so a file inside that folder gets a false `privateOutsideOwner`.
- Specifiers carrying a **query suffix** (`"./Feature/state.ts?raw"`, `"./x?foo=1"` — the Vite/webpack resource idiom) resolve to nothing and are invisible to both rules (**#13**), so they launder a crossing and lose the matching ownership edge.
- `isEntryFile` strips `path.extname` before comparing against the directory name, so a **directory whose own name ends in a source extension** (`src/state.ts/state.ts`) gets no gate (**#13**): `"state"` never equals `"state.ts"`. **Not `entry`-only** for the same reason as the symlinked door — it also invents a false `privateOutsideOwner` inside that directory.

Cache/staleness issues, all pre-existing and all verified still present:

- A newly created file forces a rebuild only when *that* file is the one being linted (**#11**), so creating `Feature/index.ts` and then linting only `app.ts` keeps a stale graph **permanently** (not for one pass — `trackedFilesChanged` iterates existing stamps, and a new file has none). In a whole-tree run it also makes findings depend on lint order: files reached before the new one get the stale answer, and the next identical invocation disagrees.
- A write landing *during* the graph build is permanently invisible (**#11**): `stampFiles` runs after every file has been read, so the write is baked into the stamp as though it preceded the build. Note this one survives any watch-vs-poll redesign — it needs the stamps taken *before* the reads.
- Repointing a symlink changes edges without changing any tracked path's stat, so it is never noticed (**#11**, same root cause as the symlinked door above: `walkDir` records only real paths, so a link path is never a graph key).
- The graph cache never evicts (**#12**); each distinct `(root, ignore)` pair retains a graph, its module-resolution cache and its indexes for the life of the process. All six derived indexes now hang off `derivedFromGraph`, so a retention fix has one place to look.
- Revalidation is bounded by `REVALIDATE_AFTER_MS`, so total stats scale as `files × pass-duration / 100 ms` (**#12**). The `visitToken` fix removed a genuine `files²` term (one sweep per file with two rules enabled) but the residual is still quadratic in a long pass; it is a large constant-factor win, not an asymptotic one. Do not describe it as linear.
- **By design:** because revalidation is time-bounded, `ownership` and `entry` can see **two different graph objects for the same file** when one file's parse spans more than `REVALIDATE_AFTER_MS` and a tracked file changes in between — `ownership` asks in `Program`, `entry` asks lazily at the first specifier, so the gap covers every other rule's work on that file. Each rule stays internally consistent (both memoise per file), but one file's report set is then not attributable to a single snapshot. This is inherent to bounded revalidation, and the trade was made deliberately: the alternative, trusting token identity without a time bound, produced *permanently* frozen output for any host that retains a `SourceCode`.
- **By design**, but know about it: passing a `visitToken` also **widens single-rule staleness relative to `main`**, which is the one measurable `ownership` behaviour change on this branch. Where `main` revalidated on every repeat call for the same file, a host that retains one `SourceCode` and re-verifies it now gets the cached graph for up to `REVALIDATE_AFTER_MS`. Bounded, and unreachable from the ESLint CLI (every parse mints a fresh token), but it is a difference, not merely an optimisation.

## Options

Schema: `{ root?: string, ignore?: string[], layers?: string[] }`, `additionalProperties: false`. Unknown names must stay rejected.

### `root`

Directory walked for the graph, and the ceiling of the ownership walk. Default `"."`. Relative `root` is resolved against `cwd`, then walked **upward** until the directory exists, stopping at the nearest `package.json` or `.git`. Unbounded walk would resolve `src` to an unrelated parent named `src`. Files outside `root` are never reported.

### `layers`

Globs for layer directories. Matched against paths relative to **both** `root` and `cwd` (so `["src/ui"]` and `["ui"]` both work with `root: "src"`). Memoised on the graph; a rebuilt graph recomputes (a new layer dir used to stay invisible until ESLint restarted).

A layer's **immediate children** are public peer owners: they may have one consumer and may sit beside trees that import them. That means files **directly in** the layer directory, plus each child folder's entry (`Button/Button.ts` or `Button/index.ts`). Deeper files are checked normally.

Declaring a layer gives up private-file reporting for those children. That is the intended trade: a public peer with one consumer is indistinguishable from a file that should have been private.

`layers: ["*"]` matches every top-level directory under `root`. Do not treat that as a no-op.

### `ignore`

Globs relative to `root`. Ignored files are neither reported nor counted as consumers, and do not populate the singleton-folder check. A glob naming a directory excludes everything under it (`["gen"]` ≡ `["gen/**"]`). Symlinks are checked under the link path **and** the real path.

No negation: each glob is independent, so `["!gen"]` matches everything except `gen` and silently disables the rule. List exclusions only.

For `colocate/entry`, `ignore` does more than silence: gates are derived from `graph.files`, so ignoring a **door** removes the gate and legalises every existing reach past it. That inverts the ratchet, and it is not what "not reported, not counted as a consumer" leads a reader to expect — check whether a glob covers an entry file before adding it.

## Reports

Emitted on `node.body[0] ?? node` so file-level `eslint-disable` still applies under ESLint 10 (Program-node reports are dropped there). Cover this with both `@typescript-eslint/parser` and Espree (`eslint-disable-ownership`, `eslint-disable-ownership-js`).

Report **order** for one file is `singletonFolder`, `privateOutsideOwner`, the shared issue, `mismatchedEntry` — the order `ownershipFindings` pushes them in. Exactly one test pins it: `two-findings-one-file` in `ownership.test.ts`, asserted **unsorted**. Every other assertion in that file sorts first, and `check:placement` does **not** catch a reordering — it builds a per-placement matrix but only prints it when a configuration has no clean placement at all, so swapping two pushes leaves the suite green, typecheck clean and `unsatisfiable=0`. Verified by mutation. Do not delete that fixture or sort its assertion. Nothing short-circuits: a file can be a singleton wrapper *and* misplaced relative to its owner, and each report names a different edit.

| messageId | when |
| --- | --- |
| `privateOutsideOwner` | one owner, file sits outside that folder |
| `sharedTooHigh` | several owners, file sits above their LCA |
| `sharedInsideOwner` | several owners, file sits inside an owner folder below the LCA (including a non-consumer owner that merely surrounds it) |
| `singletonFolder` | directory holds one source file, no companion stylesheet beside it, and the file is named after the directory or `index`. Not reported on `root` itself. Source count is recursive; stylesheets are **same directory only** (`.css` `.scss` `.sass` `.less` `.styl`). Tests, `dist`, ignored files do not count as a second source. |
| `mismatchedEntry` | `index` re-exports exactly one sibling under a different name, and outside code imports the barrel |

`mismatchedEntry` is narrow. Leave alone: index re-exporting the named entry (`Foo/index.ts` → `Foo/Foo.ts`); aggregator that also re-exports elsewhere (including an unresolvable specifier); self-reexport; index in `root`; nothing outside imports it; sibling excluded by `ignore`. Value+type split of the same module (`export { x }` + `export type { T }` from `./X`) is still **one** sibling.

Every report must be **fixable**: for `ownership` there has to exist a location the rule accepts, and for `entry` a specifier the importer can use. `check:placement` guards both — it sweeps `entry` by checking that no report names a module the importer already lives inside, since then the only "fix" would be importing its own door.

## Graph and resolution

Walk skips `node_modules`, `dist`, `coverage`, `.git`, `.hg`, `.svn`, declaration files (`.d.ts` `.d.mts` `.d.cts`), and tests (`__tests__` segment or `.test.` / `.spec.` in the basename). `isTestFile` takes a path **relative to root** — an absolute path with `__tests__` above the project would disable the rule.

Edges from `import`, `export ... from`, `import()`, `require()`, and `import x = require()`. `require` is scope-aware: a shadowed `require` is not an edge, except `const require = createRequire(...)`.

Resolution goes through the TypeScript compiler (`getParsedCommandLineOfConfigFile`, so `extends` is honoured) with **bundler** `moduleResolution` regardless of `tsc` settings: extensionless imports resolve, `./x.js` maps onto `x.ts`. Extra probe for `.cts`/`.cjs` and path-mapping targets the compiler will not try. `paths` picks **one** pattern (exact key, else longest prefix) — do not try every matching pattern.

Symlinks: follow while the real path stays inside `root`. Outside-root targets stay out of the graph (they cannot be reported; counting them as owners created phantom second owners). Sibling links to one real directory are both walked; nested links to the same real directory are entered at most once. Ignore applies to both the link path and the real path.

Case-insensitive disks: recover import specifiers that differ in case from the on-disk path. Unicode NFC/NFD differences are recovered too, on every platform, but only for `entry` (via `canonicalGraphPath`) — the graph's edge index is case-only, so `ownership` stays normalization-blind. Config/ESLint **paths** (`root`, linted filename) stay case-sensitive — `root: "SRC"` when the dir is `src` produces no findings.

A file importing itself is not an ownership edge.

## Cache and robustness

Graph cached per `root` + `ignore` for the ESLint process. Revalidated **once per lint pass** (seeing a file already in `visited`, or 100 ms elapsed). `getGraph` takes an optional trailing `visitToken: object` so more than one rule can ask about the same file within a single parse without the second ask looking like the start of a new pass: pass `context.sourceCode`, which ESLint hands to every rule as the identical object for one parse of a file and as a new object for every later parse. Neither rule passes it itself — `Subject.graph` is the only rule-facing caller and supplies it once. When a call's file and token both match the immediately preceding call **and less than `REVALIDATE_AFTER_MS` has elapsed since the last validation**, `getGraph` returns the cached graph directly, before even checking whether `tsconfig.json` or a tracked file changed — a second rule's call inside the same parse cannot have observed anything the first rule's call did not already validate. The elapsed-time bound is load-bearing and must not be dropped: token identity proves "same `SourceCode` object", not "same moment". `Linter#verify` accepts a `SourceCode` instance and passes its identity through to `context.sourceCode`, so a host that retains one and re-verifies it keeps the token alive indefinitely; without the bound that froze the graph permanently, and a report could not be cleared by editing any file other than the one being linted (pinned by `cache.test.ts`'s retained-`SourceCode` test). The token is held as a `WeakRef`, not a strong reference (a `SourceCode` runs roughly 300x its source size); a collected token derefs to `undefined`, which never matches, so a host that *drops* its ESLint instance mid-process falls onto the conservative path. A caller that omits the token — direct `getGraph` calls, a single-rule setup — keeps the original behavior: every repeat of a file counts as a new pass. Stamps are size + mtime + ctime (ctime catches `cp -p` / `rsync -t` / CI cache restore). On whole-second filesystems, a stamp in the same second as graph build is treated as suspect (`stampIsAmbiguous`). `tsconfig.json` and files it `extends` invalidate the cache. A layer directory created mid-session is picked up because it rebuilds the graph — but only once a file *inside it* is the one being linted; see Known issues.

Filesystem errors never abort the user's lint run. Missing `root`, linted path not on disk (`--stdin-filename`, processors, deleted mid-run), unreadable file or directory → no findings. All reads go through `src/lib/fs-safe.ts`.

## Invariants (do not regress)

- Do not reintroduce a `shells` option or a transitive / wholesale shell exemption.
- Folder entry files are unflaggable *in their own folder*.
- Convenience barrels over loose helpers are not owners.
- Namespace barrels (≥2 local re-exports) are not consumers; single local re-export is.
- `ignore` and `SKIP_DIRS` apply to subjects, consumers, singleton counts, and cache invalidation alike.
- Unknown options rejected; `ignore` negation unsupported.
- Reports stay silent rather than throw.
- `plugin.meta.version` stays in sync with `package.json`.
- `colocate/entry` takes no `layers` option and grants no shell or barrel exemption.
- `entry` detection stays structural; do not reuse `isOwnerEntryFile` for it.

## Tests

Vitest (`tests/**/*.test.ts`, fixtures excluded as test files). Behaviour tests are **fixture-first**: add `tests/fixtures/<name>/` and assert via `lintFixture(name, options?)` in `tests/ownership.test.ts`. Default lint target is `["src"]`; pass another glob when the fixture is not under `src`.

```ts
const messages = await lintFixture("private-sibling");
expect(sortMessages(messages)).toEqual([
  { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
  { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
]);
```

`collectMessages` throws if the fixture fails to parse — empty results must not mean "parse error". Prefer the TypeScript parser; add an Espree case only when ESLint-version behaviour differs (disable comments).

Entry assertions get whole `FixtureMessage` objects; narrow them with `pick(messages, "file", "line", "messageId")` from the same helper rather than a local `.map`. Choose the keys per assertion — `message` is the payload wherever the report names a module and a door (`entry-paths-alias`, `entry-sibling-prefix`, `entry-deep-past-door` assert it in full), and noise wherever the point is which line was flagged.

Unit/integration split:

- `ownership.test.ts` — rule findings against fixtures
- `entry.test.ts` — entry-rule findings against fixtures, including its degradation cases (missing root, missing file, unresolvable specifier) rather than in `robustness.test.ts`. Several `expect([])` assertions have no in-file positive control (the unresolvable-specifier and not-on-disk cases, plus `entry-dts-target`, both `entry-require-redeclared*` fixtures, `entry-require-nested-scope`, and the wrong-case-importer test); only the `ignore` pair does. They are not vacuous — each was verified by mutation to fail when the logic it pins is reverted, and `collectRuleMessages` throws on a parse error — but do not read a bare `[]` as evidence the rule ran.
- `gates.test.ts` — `isEntryFile`, `getGates`, `findCrossedGate` unit tests
- `harness.test.ts` — the shared fixture-lint helper itself (two-key ownership shape only; it never calls `lintEntryFixture`, so the per-rule/per-import entry shape is *not* covered here)
- `graph.test.ts` / `walk.test.ts` — resolution, walk, skip rules, temp trees + symlinks
- `cache.test.ts` — invalidation in one process (temp dirs)
- `owners.test.ts` — layer glob expansion / memoisation
- `robustness.test.ts` — ownership's degradation cases: missing root, missing file, unreadable, deleted importer
- `plugin-meta.test.ts` — exported surface
- `root.test.ts` — relative root resolution and the project-boundary ceiling

After changing owners, shells, layers, barrels, or what counts as a consumer, run `npm run check:placement`. It generates random layouts, places a subject at every plausible path, and fails if any configuration has **no** accepted location.

## Code style

- ESM: TypeScript imports use `.js` specifiers (`from "../lib/graph.js"`).
- Strict; `noUnusedLocals` / `noUnusedParameters`.
- Comments explain *why* and the bug they close, not what the next line does.
- Prefer extending a fixture over adding options. Options exist for things the graph cannot infer (`layers`, generated files).
- Do not parse or resolve with a second stack; reuse `parseSourceFile` from `parse.ts` and `resolveSpecifier` from `resolve.ts`. Do not re-derive "is this file in the model" either — `scope.ts` owns those predicates.
