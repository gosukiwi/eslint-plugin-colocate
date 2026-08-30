# Tests

Vitest (`tests/**/*.test.ts`, fixtures excluded as test files). Behaviour tests are **fixture-first**: add `tests/fixtures/<name>/` and assert via `lintFixture(name, options?)` in `tests/ownership.test.ts`. Default lint target is `["src"]`; pass another glob when the fixture is not under `src`. Prefer extending a fixture over adding options.

```ts
const messages = await lintFixture("private-sibling");
expect(sortMessages(messages)).toEqual([
  { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
  { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
]);
```

`collectMessages` throws if the fixture fails to parse — empty results must not mean "parse error". Prefer the TypeScript parser; add an Espree case only when ESLint-version behaviour differs (disable comments).

Entry assertions get whole `FixtureMessage` objects; narrow them with `pick(messages, "file", "line", "messageId")` from the same helper rather than a local `.map`. Choose the keys per assertion — `message` is the payload wherever the report names a module and a door (`entry-paths-alias`, `entry-sibling-prefix`, `entry-deep-past-door` assert it in full), and noise wherever the point is which line was flagged.

Report **order** for one file is pinned by exactly one test: `two-findings-one-file` in `ownership.test.ts`, asserted **unsorted**. Do not delete that fixture or sort its assertion. See [ownership](ownership.md).

After changing owners, shells, layers, barrels, or what counts as a consumer, run `npm run check:placement`. It generates random layouts, places a subject at every plausible path, and fails if any configuration has **no** accepted location.

```bash
npm run check:placement
CONFIGS=40 npm run check:placement
SEED=<n> npm run check:placement
```

## File split

- `ownership.test.ts` — rule findings against fixtures
- `entry.test.ts` — entry-rule findings against fixtures, including its degradation cases (missing root, missing file, unresolvable specifier) rather than in `robustness.test.ts`. Several `expect([])` assertions have no in-file positive control (the unresolvable-specifier and not-on-disk cases, plus `entry-dts-target`, both `entry-require-redeclared*` fixtures, `entry-require-nested-scope`, and the wrong-case-importer test); only the `ignore` pair does. They are not vacuous — each was verified by mutation to fail when the logic it pins is reverted, and `collectRuleMessages` throws on a parse error — but do not read a bare `[]` as evidence the rule ran.
- `gates.test.ts` — `isEntryFile`, `getGates`, `findCrossedGate` unit tests
- `named-door.test.ts` — `isNamedDoor` unit tests
- `harness.test.ts` — the shared fixture-lint helper itself (two-key ownership shape only; it never calls `lintEntryFixture`, so the per-rule/per-import entry shape is *not* covered here)
- `graph.test.ts` / `walk.test.ts` — resolution, walk, skip rules, temp trees + symlinks; `graph.test.ts` also covers importer recovery when the specifier and on-disk path differ only by NFC/NFD, using the same filesystem probe as the `collectReExports` case in `owners.test.ts`
- `parse.test.ts` — extractSpecifiers: type-position import(), no-substitution templates, and spellings that must not become edges
- `cache.test.ts` — invalidation in one process (temp dirs)
- `owners.test.ts` — layer glob expansion / memoisation, and the one `collectReExports` case that fixtures cannot express: an NFD sibling re-exported through its NFC spelling. That test probes the filesystem for normalization folding rather than reading `ts.sys.useCaseSensitiveFileNames` — the two are independent axes, and it is the fixture-free proof that `collectReExports` canonicalises at all on a case-sensitive volume.
- `robustness.test.ts` — ownership's degradation cases: missing root, missing file, unreadable, deleted importer
- `plugin-meta.test.ts` — exported surface
- `root.test.ts` — relative root resolution and the project-boundary ceiling
