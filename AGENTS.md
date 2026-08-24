# AGENTS.md

Guidance for agents working on this repository. Consumer-facing usage lives in `README.md`.

## What this is

ESLint 9+ plugin (`colocate/ownership`) that walks a source tree, builds an import graph, and reports files whose **location** does not match **who depends on them**. ESM only, Node 20+, TypeScript with `module: NodeNext`. Tests import `src/` directly; `npm run build` emits `dist/` for the published package.

Peer: `eslint >= 9`. Developed against ESLint 10. TypeScript is both a runtime dependency (compiler API for parse/resolve) and a devDependency.

## Layout

```
src/index.ts              plugin export: meta + rules.ownership
src/rules/ownership.ts    ESLint rule: options, reports, singleton/mismatchedEntry
src/lib/graph.ts          walk, specifier extract, resolve, graph cache
src/lib/owners.ts         owners, shells, layers, colocation
src/lib/fs-safe.ts        every filesystem read: degrade to skip, never throw
tests/fixtures/<name>/    one layout per scenario
tests/helpers/lint-fixture.ts
scripts/check-placement.ts  opt-in satisfiability sweep
```

`plugin.meta.version` is hardcoded in `src/index.ts`. `tests/plugin-meta.test.ts` asserts it matches `package.json` — bump both.

Rule docs URL is `https://github.com/gosukiwi/eslint-plugin-colocate#what-it-reports`. Keep a heading that GitHub slugifies to `#what-it-reports` in the README.

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

## Reports

Emitted on `node.body[0] ?? node` so file-level `eslint-disable` still applies under ESLint 10 (Program-node reports are dropped there). Cover this with both `@typescript-eslint/parser` and Espree (`eslint-disable-ownership`, `eslint-disable-ownership-js`).

| messageId | when |
| --- | --- |
| `privateOutsideOwner` | one owner, file sits outside that folder |
| `sharedTooHigh` | several owners, file sits above their LCA |
| `sharedInsideOwner` | several owners, file sits inside an owner folder below the LCA (including a non-consumer owner that merely surrounds it) |
| `singletonFolder` | directory holds one source file, no companion stylesheet beside it, and the file is named after the directory or `index`. Not reported on `root` itself. Source count is recursive; stylesheets are **same directory only** (`.css` `.scss` `.sass` `.less` `.styl`). Tests, `dist`, ignored files do not count as a second source. |
| `mismatchedEntry` | `index` re-exports exactly one sibling under a different name, and outside code imports the barrel |

`mismatchedEntry` is narrow. Leave alone: index re-exporting the named entry (`Foo/index.ts` → `Foo/Foo.ts`); aggregator that also re-exports elsewhere (including an unresolvable specifier); self-reexport; index in `root`; nothing outside imports it; sibling excluded by `ignore`. Value+type split of the same module (`export { x }` + `export type { T }` from `./X`) is still **one** sibling.

Every report must be **fixable**: there has to exist a location the rule accepts. That is what `check:placement` guards.

## Graph and resolution

Walk skips `node_modules`, `dist`, `coverage`, `.git`, `.hg`, `.svn`, declaration files (`.d.ts` `.d.mts` `.d.cts`), and tests (`__tests__` segment or `.test.` / `.spec.` in the basename). `isTestFile` takes a path **relative to root** — an absolute path with `__tests__` above the project would disable the rule.

Edges from `import`, `export ... from`, `import()`, `require()`, and `import x = require()`. `require` is scope-aware: a shadowed `require` is not an edge, except `const require = createRequire(...)`.

Resolution goes through the TypeScript compiler (`getParsedCommandLineOfConfigFile`, so `extends` is honoured) with **bundler** `moduleResolution` regardless of `tsc` settings: extensionless imports resolve, `./x.js` maps onto `x.ts`. Extra probe for `.cts`/`.cjs` and path-mapping targets the compiler will not try. `paths` picks **one** pattern (exact key, else longest prefix) — do not try every matching pattern.

Symlinks: follow while the real path stays inside `root`. Outside-root targets stay out of the graph (they cannot be reported; counting them as owners created phantom second owners). Sibling links to one real directory are both walked; nested links to the same real directory are entered at most once. Ignore applies to both the link path and the real path.

Case-insensitive disks: recover import specifiers that differ in case from the on-disk path. Config/ESLint **paths** (`root`, linted filename) stay case-sensitive — `root: "SRC"` when the dir is `src` produces no findings.

A file importing itself is not an ownership edge.

## Cache and robustness

Graph cached per `root` + `ignore` for the ESLint process. Revalidated **once per lint pass** (seeing a file already in `visited`, or 100 ms elapsed). Stamps are size + mtime + ctime (ctime catches `cp -p` / `rsync -t` / CI cache restore). On whole-second filesystems, a stamp in the same second as graph build is treated as suspect (`stampIsAmbiguous`). `tsconfig.json` and files it `extends` invalidate the cache. A layer directory created mid-session is picked up because it rebuilds the graph.

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

Unit/integration split:

- `ownership.test.ts` — rule findings against fixtures
- `graph.test.ts` / `walk.test.ts` — resolution, walk, skip rules, temp trees + symlinks
- `cache.test.ts` — invalidation in one process (temp dirs)
- `owners.test.ts` — layer glob expansion / memoisation
- `robustness.test.ts` — missing root, missing file, unreadable, deleted importer
- `plugin-meta.test.ts` — exported surface
- `root.test.ts` — relative root resolution and the project-boundary ceiling

After changing owners, shells, layers, barrels, or what counts as a consumer, run `npm run check:placement`. It generates random layouts, places a subject at every plausible path, and fails if any configuration has **no** accepted location.

## Code style

- ESM: TypeScript imports use `.js` specifiers (`from "../lib/graph.js"`).
- Strict; `noUnusedLocals` / `noUnusedParameters`.
- Comments explain *why* and the bug they close, not what the next line does.
- Prefer extending a fixture over adding options. Options exist for things the graph cannot infer (`layers`, generated files).
- Do not parse with a second stack; reuse `parseSourceFile` / `resolveSpecifier` from `graph.ts`.
