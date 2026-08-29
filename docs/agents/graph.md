# Graph, resolution, cache

## Walk and edges

Walk skips `node_modules`, `dist`, `coverage`, `.git`, `.hg`, `.svn`, declaration files (`.d.ts` `.d.mts` `.d.cts`), and tests (`__tests__` segment or `.test.` / `.spec.` in the basename). `isTestFile` takes a path **relative to root** — an absolute path with `__tests__` above the project would disable the rule.

`ignore` and `SKIP_DIRS` apply to subjects, consumers, singleton counts, and cache invalidation alike.

Edges from `import`, `export ... from`, `import()`, type-position `import()` (`import("./x").T` and `typeof import("./x")`), `require()`, and `import x = require()`. `require` is scope-aware: a shadowed `require` is not an edge, except `const require = createRequire(...)`. A file importing itself is not an ownership edge.

`parse.ts` currently takes `require`'s `arguments[0]` at any arity; `entry` narrows to a single-argument `require()`. A two-argument `require()` therefore creates a graph edge and a possible `ownership` report that `entry` will not corroborate. See [entry](entry.md) and [known-issues](known-issues.md).

## Resolution

Resolution goes through the TypeScript compiler (`getParsedCommandLineOfConfigFile`, so `extends` is honoured) with **bundler** `moduleResolution` regardless of `tsc` settings: extensionless imports resolve, `./x.js` maps onto `x.ts`. Extra probe for `.cts`/`.cjs` and path-mapping targets the compiler will not try. `paths` picks **one** pattern (exact key, else longest prefix) — do not try every matching pattern.

A throw from `ts.resolveModuleName` (malformed `tsconfig.json` `paths`) is treated as unresolved and does not abort the run.

## Symlinks

Follow while the real path stays inside `root`. Outside-root targets stay out of the graph (they cannot be reported; counting them as owners created phantom second owners). An in-root file symlink is a graph member under both its walk path and its real path; specifiers are extracted only from the real path. Sibling links to one real directory are both walked; nested links to the same real directory are entered at most once. Ignore applies to both the link path and the real path.

## Case and normalisation

Case-insensitive disks: recover import specifiers that differ in case from the on-disk path. Unicode NFC/NFD differences are recovered too, on every platform. Both recoveries are `canonicalGraphPath`, and it is applied in two places: `entry` (importer and target), and `collectReExports` in `owners.ts` (each resolved re-export target). It is **not** applied everywhere a resolved path meets the graph — `findings.ts` still compares against the un-canonicalised linted directory, which is unreachable today only because a wrong-case linted index finds no `filesInDir` and returns before the re-export scan. Do not read the two call sites as a general rule.

The graph's own **edge index** stays case-only: `buildGraphWithConfigs` recovers a resolved target through `filesByLowerCase`, so an edge whose specifier differs from disk only by normalization is still dropped (issue #16). That leaves the two halves of the model disagreeing on exactly that input — `collectReExports` folds NFC and will call such a target a local sibling, while `graph.importers` holds no edge for it. Config/ESLint **paths** (`root`, linted filename) stay case-sensitive — `root: "SRC"` when the dir is `src` produces no findings.

`collectReExports` resolves with the graph's `ResolutionSettings` (`getGraphResolutionSettings`) and canonicalises every resolved path, so a sibling is a sibling whatever the specifier's spelling — relative, aliased through tsconfig `paths`, or wrong-case. Do not put a bare `resolveSpecifier(specifier, dir)` back there: the settings parameter is optional and falls back to a lenient default with no project `paths`, so an aliased re-export resolves to nothing with nothing looking broken, which silently reclassifies the barrel and moves every finding downstream of `getColocationConsumers`. For the same reason its aggregated-module count keys on the resolved module, falling back to the specifier text only when the specifier does not resolve — keying on text alone made two spellings of one module look like an aggregator.

## Cache

Graph cached per `root` + `ignore` for the ESLint process. Revalidated **once per lint pass** (seeing a file already in `visited`, or 100 ms elapsed). `getGraph` takes an optional trailing `visitToken: object` so more than one rule can ask about the same file within a single parse without the second ask looking like the start of a new pass: pass `context.sourceCode`, which ESLint hands to every rule as the identical object for one parse of a file and as a new object for every later parse. Neither rule passes it itself — `Subject.graph` is the only rule-facing caller and supplies it once. When a call's file and token both match the immediately preceding call **and less than `REVALIDATE_AFTER_MS` has elapsed since the last validation**, `getGraph` returns the cached graph directly, before even checking whether `tsconfig.json` or a tracked file changed — a second rule's call inside the same parse cannot have observed anything the first rule's call did not already validate. The elapsed-time bound is load-bearing and must not be dropped: token identity proves "same `SourceCode` object", not "same moment". `Linter#verify` accepts a `SourceCode` instance and passes its identity through to `context.sourceCode`, so a host that retains one and re-verifies it keeps the token alive indefinitely; without the bound that froze the graph permanently, and a report could not be cleared by editing any file other than the one being linted (pinned by `cache.test.ts`'s retained-`SourceCode` test). The token is held as a `WeakRef`, not a strong reference (a `SourceCode` runs roughly 300x its source size); a collected token derefs to `undefined`, which never matches, so a host that *drops* its ESLint instance mid-process falls onto the conservative path. A caller that omits the token — direct `getGraph` calls, a single-rule setup — keeps the original behavior: every repeat of a file counts as a new pass. On rebuild, `builtAt` is recorded at the start of the walk; stamps are taken after the walk finishes and before any source file contents are read. Stamps are size + mtime + ctime (ctime catches `cp -p` / `rsync -t` / CI cache restore). Revalidation also stamps every directory the walk entered, so a new file is seen when a different file is linted. On whole-second filesystems, a stamp in any second from rebuild start through stamping is treated as suspect (`stampIsAmbiguous`). `tsconfig.json` and files it `extends` invalidate the cache.

Two consequences of bounded revalidation, both deliberate, neither a bug:

- `ownership` and `entry` can see **two different graph objects for the same file** when one file's parse spans more than `REVALIDATE_AFTER_MS` and a tracked file changes in between: `ownership` asks in `Program`, `entry` asks lazily at the first specifier, so the gap covers every other rule's work on that file. Each rule stays internally consistent (both memoise per file), but one file's report set is then not attributable to a single snapshot. Inherent to bounding staleness by time, and the alternative was worse — trusting token identity without a bound froze output permanently for any host that retains a `SourceCode`.
- Passing a `visitToken` **widens single-rule staleness** compared with the pre-`entry`-rule behaviour, and this is the one measurable change to `ownership` that the entry rule brought with it. Previously every repeat call for the same file revalidated; now a host that retains one `SourceCode` and re-verifies it gets the cached graph for up to `REVALIDATE_AFTER_MS`. Bounded, and unreachable from the ESLint CLI because every parse mints a fresh token — but it is a difference, not purely an optimisation.

## Robustness

Filesystem errors never abort the user's lint run. Missing `root`, linted path not on disk (`--stdin-filename`, processors, deleted mid-run), unreadable file or directory → no findings. All reads go through `src/lib/fs-safe.ts`.
