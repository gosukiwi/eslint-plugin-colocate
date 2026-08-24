# `colocate/entry` Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second rule, `colocate/entry`, that reports imports which reach past a module's entry file into its internals.

**Architecture:** A **gate** is any directory containing an entry file (`Dir/Dir.ext` or `Dir/index.ext`) — detected structurally, unlike `ownership`'s entry which additionally requires an outside importer. An import is illegal when its target is not an entry file *and* some gate contains the target but not the importer. The rule walks ESLint's own AST for the linted file, resolves each specifier with the same TypeScript settings the graph used, and reports on the specifier node, naming the innermost crossed gate. Gate lookup is a `Map<dir, entry>` memoised per `Graph` in a `WeakMap`, matching the existing `shellsByGraph` / `layerDirsByGraph` pattern.

**Tech Stack:** TypeScript (`module: NodeNext`, ESM, `.js` import specifiers), ESLint 9+/10 flat config, TypeScript compiler API for resolution, Vitest with on-disk fixtures.

---

## Design decisions already settled

These were decided in full and are **not** open for re-litigation during implementation:

| Decision | Value |
| --- | --- |
| Rule name / message id | `colocate/entry`, single id `reachesPastEntry` |
| Options | `{ root, ignore }` — **no** `layers` |
| Entry detection | Structural: basename equals directory name, or `index`. No `entryNames` option |
| Nested doors | Legal — landing on *any* entry is legal, even a child's |
| Report anchor | The import specifier node in the importing file |
| Gate named in message | **Innermost** crossed gate; prefer `index` when a directory has two doors |
| Shell exemption | **Not** applied — this rule intentionally checks entry-point files |
| Type-only imports | Treated identically to value imports |
| Barrels as importers | **No** exemption — a barrel reaching past a gate is flagged |
| Tests / `.d.ts` / assets | Invisible, inherited from the graph. No special handling |
| Autofix | None — rewriting a specifier yields non-compiling code when the door lacks the export |
| Door-export checking | None — report the boundary, the door is the developer's call |
| "Must have an entry" | Not enforced. The rule is a ratchet: no entry ⇒ no gate ⇒ silent |
| `configs.recommended` | Not added |
| `ownership` rule | **Untouched** |

## File structure

| File | Responsibility |
| --- | --- |
| `src/lib/root.ts` (create) | `resolveRootDir` extracted from `ownership.ts` so both rules share it |
| `src/lib/gates.ts` (create) | `isEntryFile`, `getGates`, `findCrossedGate` — the entire gate model |
| `src/lib/graph.ts` (modify) | Expose per-`Graph` `ResolutionSettings` so a rule can resolve specifiers identically |
| `src/rules/entry.ts` (create) | The rule: options, AST visitors, reports |
| `src/rules/ownership.ts` (modify) | Drop the local `resolveRootDir`, import from `lib/root.js` |
| `src/index.ts` (modify) | Register `entry` alongside `ownership` |
| `tests/helpers/lint-fixture.ts` (modify) | Accept a rule name; return `line` and `message` for entry assertions |
| `tests/harness.test.ts` (create) | Guards the harness generalisation itself |
| `tests/root.test.ts` (create) | Unit tests for the extracted `resolveRootDir` |
| `tests/entry.test.ts` (create) | Fixture-driven behaviour tests |
| `tests/gates.test.ts` (create) | Unit tests for `isEntryFile`, `getGates`, `findCrossedGate` |
| `tests/fixtures/entry-*/` (create) | One directory layout per scenario |
| `README.md`, `AGENTS.md` (modify) | Consumer docs + agent guidance |

---

### Task 1: Generalise the test harness to a second rule

`makeESLint` hardcodes `"colocate/ownership"` in its config and `collectMessages` filters on that same string, so no entry test can run until this changes. Entry reports are per-import, so several land in one file — assertions need `line` and `message`, which the current `{ file, messageId }` shape lacks. Existing `ownership.test.ts` assertions must keep passing unchanged.

**Files:**
- Modify: `tests/helpers/lint-fixture.ts`

The entry rule does not exist yet, so this task is verified through the `ownership` rule. That keeps the suite green at every commit: enabling `colocate/entry` in a flat config before the plugin exports it makes ESLint throw at config resolution, not fail an assertion.

- [ ] **Step 1: Write the failing test**

Create `tests/harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lintFixture, lintFixtureRule } from "./helpers/lint-fixture.js";

describe("fixture harness", () => {
  it("keeps the two-key shape the ownership assertions were written against", async () => {
    const messages = await lintFixture("singleton-flag");
    expect(messages).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  // Entry reports are per-import, so several land in one file and assertions
  // need to tell them apart.
  it("exposes line and message when a rule is named explicitly", async () => {
    const messages = await lintFixtureRule("singleton-flag", "ownership");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      file: "src/Foo/Foo.ts",
      messageId: "singletonFolder",
    });
    expect(messages[0].line).toBeGreaterThan(0);
    expect(messages[0].message).toContain("colocate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/harness.test.ts`
Expected: FAIL — `lintFixtureRule` is not exported from `./helpers/lint-fixture.js`.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `tests/helpers/lint-fixture.ts` below the `fixturesDir` constant with:

```ts
export type RuleName = "ownership" | "entry";

export interface FixtureMessage {
  file: string;
  messageId: string;
  line: number;
  message: string;
}

export function makeESLint(
  cwd: string,
  ruleOptions?: Record<string, unknown>,
  options?: { parser?: "typescript" | "espree"; rule?: RuleName },
): ESLint {
  const languageOptions =
    options?.parser === "espree"
      ? {
          sourceType: "module" as const,
          ecmaVersion: 2022 as const,
        }
      : {
          parser: tsParser,
          parserOptions: {
            sourceType: "module",
            ecmaVersion: 2022,
          },
        };

  const ruleName = options?.rule ?? "ownership";

  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
        plugins: {
          colocate: plugin,
        },
        rules: {
          [`colocate/${ruleName}`]: ["error", ruleOptions ?? {}],
        },
        languageOptions,
      },
    ],
  });
}

export function collectMessages(
  cwd: string,
  results: ESLint.LintResult[],
  ruleName: RuleName = "ownership",
): FixtureMessage[] {
  const messages: FixtureMessage[] = [];
  const fatal: string[] = [];
  const ruleId = `colocate/${ruleName}`;

  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal === true) {
        fatal.push(
          `${path.relative(cwd, result.filePath)}:${message.line} ${message.message}`,
        );
        continue;
      }
      if (message.ruleId === ruleId && message.messageId) {
        messages.push({
          file: path.relative(cwd, result.filePath),
          messageId: message.messageId,
          line: message.line,
          message: message.message,
        });
      }
    }
  }

  // A fixture that stops parsing would otherwise silently satisfy every
  // "expect no messages" assertion.
  if (fatal.length > 0) {
    throw new Error(`fixture produced parse errors:\n${fatal.join("\n")}`);
  }

  return messages;
}

/**
 * Ownership assertions compare whole objects, so this keeps the two-key shape
 * they were written against. Entry assertions need line and message, so they
 * use lintFixtureRule instead.
 */
export async function lintFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
  options?: { parser?: "typescript" | "espree" },
): Promise<{ file: string; messageId: string }[]> {
  const cwd = path.join(fixturesDir, name);
  const results = await makeESLint(cwd, ruleOptions, {
    ...options,
    rule: "ownership",
  }).lintFiles(targets);
  return collectMessages(cwd, results, "ownership").map(
    ({ file, messageId }) => ({ file, messageId }),
  );
}

export async function lintFixtureRule(
  name: string,
  rule: RuleName,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
): Promise<FixtureMessage[]> {
  const cwd = path.join(fixturesDir, name);
  const results = await makeESLint(cwd, ruleOptions, { rule }).lintFiles(targets);
  return collectMessages(cwd, results, rule);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/harness.test.ts`
Expected: 2 tests PASS.

Run: `npm test`
Expected: everything PASSES — `ownership.test.ts`, `graph.test.ts`, `cache.test.ts`, `owners.test.ts`, `robustness.test.ts`, `walk.test.ts`, `plugin-meta.test.ts` and the new `harness.test.ts`.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/lint-fixture.ts tests/harness.test.ts
git commit -m "test: let the fixture harness target either rule"
```

---

### Task 2: Extract `resolveRootDir` into `src/lib/root.ts`

Both rules need it and it is currently private to `ownership.ts`. Pure move, no behaviour change.

**Files:**
- Create: `src/lib/root.ts`
- Modify: `src/rules/ownership.ts:111-149` (remove `isProjectBoundary` + `resolveRootDir`), and its import block

- [ ] **Step 1: Write the failing test**

Create `tests/root.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRootDir } from "../src/lib/root.js";

describe("resolveRootDir", () => {
  it("returns an absolute root unchanged", () => {
    expect(resolveRootDir("/tmp/whatever", "/anywhere")).toBe("/tmp/whatever");
  });

  it("finds a relative root from a subdirectory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-root-"));
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src", "nested"), { recursive: true });

    expect(resolveRootDir("src", path.join(base, "src", "nested"))).toBe(
      path.join(base, "src"),
    );
  });

  it("stops at the project boundary instead of escaping the checkout", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-root-"));
    fs.mkdirSync(path.join(base, "project"), { recursive: true });
    fs.writeFileSync(path.join(base, "project", "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src"));

    // "src" exists above the project, but the walk must not reach it.
    expect(resolveRootDir("src", path.join(base, "project"))).toBe(
      path.join(base, "project", "src"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/root.test.ts`
Expected: FAIL — cannot resolve `../src/lib/root.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/root.ts`:

```ts
import path from "node:path";
import { safeStat } from "./fs-safe.js";

// A relative root is resolved against the working directory, but ESLint may be
// invoked from anywhere - a subdirectory, via lint-staged, from a monorepo script.
// Resolving "src" against cwd alone meant the directory was simply not found from
// a subdirectory, and a missing root reports nothing, so the rule went quiet
// instead of complaining. Walk up until the configured root exists.
function isProjectBoundary(dir: string): boolean {
  return (
    safeStat(path.join(dir, "package.json")) !== undefined ||
    safeStat(path.join(dir, ".git")) !== undefined
  );
}

export function resolveRootDir(rootOption: string, cwd: string): string {
  if (path.isAbsolute(rootOption)) {
    return rootOption;
  }

  let dir = cwd;
  while (true) {
    const candidate = path.resolve(dir, rootOption);
    if (safeStat(candidate)?.isDirectory() === true) {
      return candidate;
    }
    // Stop at the project it belongs to. Unbounded, the walk would happily
    // resolve root: "src" to a checkout's parent directory that happens to be
    // called src, taking unrelated projects into the graph and making the
    // findings depend on where the repository sits on disk.
    if (isProjectBoundary(dir)) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return path.resolve(cwd, rootOption);
}
```

Delete lines 111-149 of `src/rules/ownership.ts` (the `isProjectBoundary` comment block, `isProjectBoundary`, and `resolveRootDir`). Add to its imports:

```ts
import { resolveRootDir } from "../lib/root.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/root.test.ts`
Expected: 3 tests PASS.

Run: `npm test && npm run typecheck`
Expected: all pass except the known `tests/entry.test.ts` failure. If `typecheck` reports `safeStat` unused in `ownership.ts`, remove it from that import list.

- [ ] **Step 5: Commit**

```bash
git add src/lib/root.ts src/rules/ownership.ts tests/root.test.ts
git commit -m "refactor: extract resolveRootDir so both rules can share it"
```

---

### Task 3: Expose per-`Graph` resolution settings

`resolveSpecifier` needs the project's compiler options to resolve aliased specifiers like `@/components/Foo`. The graph builds those settings at `graph.ts:591` and throws them away. A rule resolving specifiers itself must reuse the *same* settings, and their lifetime must be the graph's — a rebuilt graph must not hand back a stale module-resolution cache.

**Files:**
- Modify: `src/lib/graph.ts` (near the other module-level caches, and `buildGraphWithConfigs` around line 590-624)
- Test: `tests/graph.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/graph.test.ts`:

```ts
describe("getGraphResolutionSettings", () => {
  it("hands back the settings the graph resolved with", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-settings-"));
    fs.mkdirSync(path.join(base, "src"));
    fs.writeFileSync(path.join(base, "src", "a.ts"), "export const a = 1;\n");

    const graph = getGraph(
      path.join(base, "src"),
      [],
      path.join(base, "src", "a.ts"),
    );
    const settings = getGraphResolutionSettings(graph);

    expect(settings).toBeDefined();
    expect(settings?.options).toBeDefined();
    expect(Array.isArray(settings?.configPaths)).toBe(true);
  });

  it("returns undefined for a graph it never built", () => {
    expect(
      getGraphResolutionSettings({ files: [], importers: new Map() }),
    ).toBeUndefined();
  });
});
```

Change that file's graph import (currently line 6) to add the new export:

```ts
import {
  getGraph,
  getGraphResolutionSettings,
  isTestFile,
} from "../src/lib/graph.js";
```

`fs`, `os` and `path` are already imported there. Do **not** assert on `options.moduleResolution` — `createResolutionSettings` spreads `RESOLUTION_OVERRIDES` first and the project's own compiler options after it, so the effective value depends on the temp directory's tsconfig.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graph.test.ts`
Expected: FAIL — `getGraphResolutionSettings` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/graph.ts`, immediately after the `ResolutionSettings` interface (line 338-346), add:

```ts
// Keyed on the graph object so the settings - including the TypeScript module
// resolution cache inside them - live exactly as long as the graph they were
// built for. A rebuilt graph is a new object, so a rule can never be handed a
// resolution cache that predates a file being added or removed.
const settingsByGraph = new WeakMap<Graph, ResolutionSettings>();

export function getGraphResolutionSettings(
  graph: Graph,
): ResolutionSettings | undefined {
  return settingsByGraph.get(graph);
}
```

Then change the end of `buildGraphWithConfigs` (currently line 624) from:

```ts
  return { graph: { importers, files }, configPaths: settings.configPaths };
```

to:

```ts
  const graph: Graph = { importers, files };
  settingsByGraph.set(graph, settings);
  return { graph, configPaths: settings.configPaths };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/graph.test.ts`
Expected: all PASS, including the new test.

Run: `npm test && npm run typecheck`
Expected: all pass except the known `tests/entry.test.ts` failure.

- [ ] **Step 5: Commit**

```bash
git add src/lib/graph.ts tests/graph.test.ts
git commit -m "feat: expose the resolution settings a graph was built with"
```

---

### Task 4: The gate model in `src/lib/gates.ts`

**Files:**
- Create: `src/lib/gates.ts`
- Test: `tests/gates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/gates.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/graph.js";
import { findCrossedGate, getGates, isEntryFile } from "../src/lib/gates.js";

const root = path.join(path.sep, "p", "src");
const at = (...parts: string[]): string => path.join(root, ...parts);

function graphOf(...files: string[]): Graph {
  return { files: [...files].sort(), importers: new Map() };
}

describe("isEntryFile", () => {
  it("accepts a file named after its directory", () => {
    expect(isEntryFile(at("Feature", "Feature.ts"))).toBe(true);
  });

  it("accepts an index regardless of extension", () => {
    expect(isEntryFile(at("Feature", "index.tsx"))).toBe(true);
  });

  it("rejects any other sibling", () => {
    expect(isEntryFile(at("Feature", "helper.ts"))).toBe(false);
  });

  // The ownership model also requires an outside importer for an index; access
  // does not, or a freshly added door would gate nothing until someone used it.
  it("does not care who imports the entry", () => {
    expect(isEntryFile(at("Untouched", "index.ts"))).toBe(true);
  });
});

describe("getGates", () => {
  it("maps each directory holding an entry to that entry", () => {
    const graph = graphOf(at("Feature", "Feature.ts"), at("Feature", "helper.ts"));
    expect(getGates(graph).get(at("Feature"))).toBe(at("Feature", "Feature.ts"));
  });

  it("prefers index when a directory has two doors", () => {
    const graph = graphOf(at("Feature", "Feature.ts"), at("Feature", "index.ts"));
    expect(getGates(graph).get(at("Feature"))).toBe(at("Feature", "index.ts"));
  });

  it("does not gate a directory with no entry", () => {
    const graph = graphOf(at("tabs", "One.ts"), at("tabs", "Two.ts"));
    expect(getGates(graph).has(at("tabs"))).toBe(false);
  });
});

describe("findCrossedGate", () => {
  const graph = graphOf(
    at("app.ts"),
    at("Outer", "index.ts"),
    at("Outer", "Inner", "Inner.ts"),
    at("Outer", "Inner", "deep.ts"),
  );

  it("reports the innermost gate the importer is outside of", () => {
    const crossed = findCrossedGate(
      at("Outer", "Inner", "deep.ts"),
      at("app.ts"),
      graph,
      root,
    );
    expect(crossed).toEqual({
      dir: at("Outer", "Inner"),
      entry: at("Outer", "Inner", "Inner.ts"),
    });
  });

  // Nested doors count: landing on any entry is legal, even a child's.
  it("allows an entry file as a target", () => {
    expect(
      findCrossedGate(at("Outer", "Inner", "Inner.ts"), at("app.ts"), graph, root),
    ).toBeUndefined();
  });

  it("allows an importer that lives inside the gate", () => {
    expect(
      findCrossedGate(
        at("Outer", "Inner", "deep.ts"),
        at("Outer", "Inner", "Inner.ts"),
        graph,
        root,
      ),
    ).toBeUndefined();
  });

  it("reports the outer gate when the importer sits between the two", () => {
    const crossed = findCrossedGate(
      at("Outer", "Inner", "deep.ts"),
      at("Outer", "index.ts"),
      graph,
      root,
    );
    expect(crossed?.dir).toBe(at("Outer", "Inner"));
  });

  it("finds nothing when no directory on the path has an entry", () => {
    const flat = graphOf(at("tabs", "One.ts"), at("tabs", "Two.ts"), at("app.ts"));
    expect(
      findCrossedGate(at("tabs", "One.ts"), at("app.ts"), flat, root),
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gates.test.ts`
Expected: FAIL — cannot resolve `../src/lib/gates.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/gates.ts`:

```ts
import path from "node:path";
import type { Graph } from "./graph.js";

const gatesByGraph = new WeakMap<Graph, Map<string, string>>();

/**
 * Structural on purpose. The ownership model only treats an `index` as an entry
 * when code outside the directory imports through it, because a convenience
 * barrel over loose helpers must not redraw ownership boundaries. Access is the
 * other question: a door is a door the moment it exists, or adding one would
 * gate nothing until every consumer had already migrated to it.
 */
export function isEntryFile(filePath: string): boolean {
  const base = path.basename(filePath, path.extname(filePath));
  return base === "index" || base === path.basename(path.dirname(filePath));
}

/**
 * Every gated directory mapped to the entry that names it. `index` wins when a
 * directory holds both spellings: it is the door that makes the bare directory
 * specifier resolve, so it is the shorter fix to suggest, and picking it is a
 * stable tiebreak rather than a filesystem-order accident.
 */
export function getGates(graph: Graph): Map<string, string> {
  const cached = gatesByGraph.get(graph);
  if (cached !== undefined) {
    return cached;
  }

  const gates = new Map<string, string>();
  for (const file of graph.files) {
    if (!isEntryFile(file)) {
      continue;
    }
    const dir = path.dirname(file);
    const isIndex = path.basename(file, path.extname(file)) === "index";
    if (!gates.has(dir) || isIndex) {
      gates.set(dir, file);
    }
  }

  gatesByGraph.set(graph, gates);
  return gates;
}

function isInsideDir(filePath: string, dir: string): boolean {
  return filePath.startsWith(dir + path.sep);
}

/**
 * The innermost gate containing `target` but not `importer`, or undefined when
 * no boundary separates them.
 *
 * Walking up from the target finds the innermost one directly: a deeper gate
 * always nests inside a shallower one, so an importer inside the deeper gate is
 * inside the shallower one too. The first directory that both gates the target
 * and excludes the importer is therefore the innermost such gate.
 */
export function findCrossedGate(
  target: string,
  importer: string,
  graph: Graph,
  rootDir: string,
): { dir: string; entry: string } | undefined {
  // Checked against the file itself, not against the gate map: a directory with
  // both doors maps only to its index, and `Dir/Dir.ts` is still a legal target.
  if (isEntryFile(target)) {
    return undefined;
  }

  const gates = getGates(graph);
  let dir = path.dirname(target);

  while (true) {
    const entry = gates.get(dir);
    if (entry !== undefined && !isInsideDir(importer, dir)) {
      return { dir, entry };
    }
    if (dir === rootDir) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/gates.test.ts`
Expected: 11 tests PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gates.ts tests/gates.test.ts
git commit -m "feat: add the gate model for entry-boundary checks"
```

---

### Task 5: The rule — static imports

Covers `ImportDeclaration` only. Later tasks add the other four specifier forms.

**Files:**
- Create: `src/rules/entry.ts`
- Modify: `src/index.ts`, `tests/helpers/lint-fixture.ts`
- Test: `tests/entry.test.ts`, `tests/plugin-meta.test.ts`
- Create: `tests/fixtures/entry-reaches-past/`, `tests/fixtures/entry-through-door-ok/`

- [ ] **Step 1: Write the failing test**

Create `tests/fixtures/entry-reaches-past/src/app.ts`:

```ts
import { helper } from "./Feature/helper";

export const app = helper;
```

Create `tests/fixtures/entry-reaches-past/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

Create `tests/fixtures/entry-reaches-past/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

Create `tests/fixtures/entry-through-door-ok/src/app.ts`:

```ts
import { Feature } from "./Feature/Feature";

export const app = Feature;
```

Create `tests/fixtures/entry-through-door-ok/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

Create `tests/entry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { lintEntryFixture } from "./helpers/lint-fixture.js";

describe("entry rule", () => {
  // src/app.ts is an entry point: nothing imports it, so the ownership model
  // would treat it as shell and exempt what it imports. This rule must not -
  // a shell burrowing into a feature's internals is the finding worth having.
  it("reports an import that reaches past a module's entry", async () => {
    const messages = await lintEntryFixture("entry-reaches-past");
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("allows an import that lands on the entry", async () => {
    const messages = await lintEntryFixture("entry-through-door-ok");
    expect(messages).toEqual([]);
  });

  it("takes only root and ignore, and rejects unknown options", () => {
    const schema = plugin.rules.entry.meta?.schema;
    const first = Array.isArray(schema)
      ? (schema[0] as {
          additionalProperties: boolean;
          properties: Record<string, unknown>;
        })
      : undefined;
    expect(first?.additionalProperties).toBe(false);
    expect(Object.keys(first?.properties ?? {}).sort()).toEqual([
      "ignore",
      "root",
    ]);
  });

  // Rewriting a specifier produces code that does not compile whenever the door
  // does not re-export the symbol, which is the common case.
  it("offers no autofix", () => {
    expect(plugin.rules.entry.meta?.fixable).toBeUndefined();
  });
});
```

Add to `tests/plugin-meta.test.ts`, inside the `describe("plugin surface", ...)` block:

```ts
  it("exposes the entry rule with documentation metadata", () => {
    const rule = plugin.rules.entry;
    expect(rule.meta?.type).toBe("problem");
    expect(rule.meta?.docs?.url).toMatch(/^https:\/\//);
    expect(Object.keys(rule.meta?.messages ?? {}).sort()).toEqual([
      "reachesPastEntry",
    ]);
  });

  // Adding a rule to a shipped preset would make every future rule a breaking
  // change, so the plugin deliberately exports none.
  it("ships no configs", () => {
    expect((plugin as { configs?: unknown }).configs).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entry.test.ts tests/plugin-meta.test.ts`
Expected: FAIL — `plugin.rules.entry` is undefined and ESLint cannot find rule `colocate/entry`.

- [ ] **Step 3: Write minimal implementation**

Create `src/rules/entry.ts`:

```ts
import path from "node:path";
import type { Rule } from "eslint";
import type * as ESTree from "estree";
import { safeRealpath } from "../lib/fs-safe.js";
import { findCrossedGate } from "../lib/gates.js";
import {
  getGraph,
  getGraphResolutionSettings,
  isExcludedPath,
  isOutsideRoot,
  isSourceFile,
  isTestFile,
  resolveSpecifier,
  type Graph,
} from "../lib/graph.js";
import { resolveRootDir } from "../lib/root.js";

interface RuleOptions {
  root?: string;
  ignore?: string[];
}

function toPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require imports to enter a module through its entry file",
      url: "https://github.com/gosukiwi/eslint-plugin-colocate#the-entry-rule",
    },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string" },
          ignore: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      reachesPastEntry:
        "'{{target}}' is inside module '{{module}}'; import it through '{{entry}}', or move it out of '{{module}}' if it is not part of it.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    const rootOption = options.root ?? ".";
    const ignore = options.ignore ?? [];

    if (!isSourceFile(context.filename)) {
      return {};
    }

    // Resolved eagerly but tolerantly: a root that is not on disk, or a linted
    // path that is not a real file (processors, --stdin-filename, deleted
    // mid-run), means "nothing to say" rather than a crash.
    const rootDir = resolveRootDir(rootOption, context.cwd);
    const realRootDir = safeRealpath(rootDir);
    const realFilename = safeRealpath(context.filename);
    if (realRootDir === undefined || realFilename === undefined) {
      return {};
    }

    const relPath = path.relative(realRootDir, realFilename);
    if (
      isOutsideRoot(relPath) ||
      isTestFile(relPath) ||
      isExcludedPath(relPath, ignore)
    ) {
      return {};
    }

    const fromDir = path.dirname(realFilename);
    // One graph per linted file, fetched on the first specifier rather than up
    // front so a file with no imports does not pay for it.
    let graph: Graph | undefined;

    const check = (specifier: string, node: ESTree.Node): void => {
      graph ??= getGraph(rootDir, ignore, realFilename);
      const target = resolveSpecifier(
        specifier,
        fromDir,
        getGraphResolutionSettings(graph),
      );
      if (target === undefined) {
        return;
      }

      const targetRel = path.relative(realRootDir, target);
      if (
        isOutsideRoot(targetRel) ||
        isTestFile(targetRel) ||
        isExcludedPath(targetRel, ignore)
      ) {
        return;
      }

      const crossed = findCrossedGate(target, realFilename, graph, realRootDir);
      if (crossed === undefined) {
        return;
      }

      context.report({
        node,
        messageId: "reachesPastEntry",
        data: {
          target: toPosix(realRootDir, target),
          module: toPosix(realRootDir, crossed.dir),
          entry: toPosix(realRootDir, crossed.entry),
        },
      });
    };

    const checkSource = (source: ESTree.Node | null | undefined): void => {
      if (
        source === null ||
        source === undefined ||
        source.type !== "Literal" ||
        typeof source.value !== "string"
      ) {
        return;
      }
      check(source.value, source);
    };

    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
    };
  },
};

export default rule;
```

Replace `src/index.ts` with:

```ts
import entry from "./rules/entry.js";
import ownership from "./rules/ownership.js";

export default {
  meta: {
    name: "eslint-plugin-colocate",
    version: "0.0.0",
  },
  rules: {
    entry,
    ownership,
  },
};
```

Now that the plugin exports the rule, add the wrapper to `tests/helpers/lint-fixture.ts`:

```ts
export async function lintEntryFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
): Promise<FixtureMessage[]> {
  return lintFixtureRule(name, "entry", ruleOptions, targets);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts tests/plugin-meta.test.ts`
Expected: all PASS.

Run: `npm test && npm run typecheck`
Expected: everything PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/rules/entry.ts src/index.ts tests/helpers/lint-fixture.ts tests/entry.test.ts tests/plugin-meta.test.ts tests/fixtures/entry-reaches-past tests/fixtures/entry-through-door-ok
git commit -m "feat: add colocate/entry for static imports"
```

---

### Task 6: Legal cases — bare directory specifier, importer inside, ungated directory

Locks in the three ways an import is legal, including the ratchet property: a directory with no entry gates nothing.

**Files:**
- Create: `tests/fixtures/entry-index-door-ok/`, `tests/fixtures/entry-importer-inside-ok/`, `tests/fixtures/entry-no-door-ok/`
- Modify: `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-index-door-ok/src/app.ts`:

```ts
import { Feature } from "./Feature";

export const app = Feature;
```

`tests/fixtures/entry-index-door-ok/src/Feature/index.ts`:

```ts
export { Feature } from "./Feature";
```

`tests/fixtures/entry-index-door-ok/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-importer-inside-ok/src/app.ts`:

```ts
import { Feature } from "./Feature/Feature";

export const app = Feature;
```

`tests/fixtures/entry-importer-inside-ok/src/Feature/Feature.ts`:

```ts
import { helper } from "./helper";

export const Feature = helper;
```

`tests/fixtures/entry-importer-inside-ok/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

`tests/fixtures/entry-no-door-ok/src/app.ts`:

```ts
import { one } from "./tabs/One";
import { two } from "./tabs/Two";

export const app = one + two;
```

`tests/fixtures/entry-no-door-ok/src/tabs/One.ts`:

```ts
export const one = 1;
```

`tests/fixtures/entry-no-door-ok/src/tabs/Two.ts`:

```ts
export const two = 2;
```

Add to `tests/entry.test.ts` inside `describe("entry rule", ...)`:

```ts
  it("allows a bare directory specifier that resolves to the index", async () => {
    const messages = await lintEntryFixture("entry-index-door-ok");
    expect(messages).toEqual([]);
  });

  it("allows a module's own files to import each other", async () => {
    const messages = await lintEntryFixture("entry-importer-inside-ok");
    expect(messages).toEqual([]);
  });

  // The ratchet: a folder with no entry is not a gate, so nothing is demanded
  // of it. Adding a door later is what turns the boundary on.
  it("says nothing about a directory with no entry file", async () => {
    const messages = await lintEntryFixture("entry-no-door-ok");
    expect(messages).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/entry.test.ts`
Expected: all three new tests PASS. These are regression tests pinning behaviour Tasks 4 and 5 already implement, so green is the correct first result — there is no red phase to stage.

If `entry-index-door-ok` reports, `isEntryFile` is comparing against the specifier text rather than `path.basename(path.dirname(file))`. If `entry-no-door-ok` reports, `getGates` is adding directories that hold no entry.

- [ ] **Step 3: Fix any failure**

No production change expected. If a test fails, correct `src/lib/gates.ts` using the diagnosis above rather than adjusting the expectation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/entry.test.ts tests/fixtures/entry-index-door-ok tests/fixtures/entry-importer-inside-ok tests/fixtures/entry-no-door-ok
git commit -m "test: cover the three legal entry cases"
```

---

### Task 7: Nested doors and the two-door tiebreak

Two decisions in one fixture pair: entering at a child's door is legal, the message names the **innermost** gate, and `index` wins when a directory has both spellings.

**Files:**
- Create: `tests/fixtures/entry-nested-doors/`, `tests/fixtures/entry-two-doors/`
- Modify: `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-nested-doors/src/app.ts`:

```ts
import { Inner } from "./Outer/Inner/Inner";
import { deep } from "./Outer/Inner/deep";

export const app = Inner + deep;
```

`tests/fixtures/entry-nested-doors/src/Outer/index.ts`:

```ts
export const Outer = 1;
```

`tests/fixtures/entry-nested-doors/src/Outer/Inner/Inner.ts`:

```ts
export const Inner = 2;
```

`tests/fixtures/entry-nested-doors/src/Outer/Inner/deep.ts`:

```ts
export const deep = 3;
```

`tests/fixtures/entry-two-doors/src/app.ts`:

```ts
import { helper } from "./Feature/helper";

export const app = helper;
```

`tests/fixtures/entry-two-doors/src/Feature/index.ts`:

```ts
export { Feature } from "./Feature";
```

`tests/fixtures/entry-two-doors/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-two-doors/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

Add to `tests/entry.test.ts`:

```ts
  // Nested doors count as doors. Entering Outer at Inner's entry is legal, so
  // only the reach past every door is reported - and it names Inner, the
  // innermost gate, because that is the one-edit fix.
  it("allows a child's door and names the innermost gate", async () => {
    const messages = await lintEntryFixture("entry-nested-doors");
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 2,
        message:
          "'Outer/Inner/deep.ts' is inside module 'Outer/Inner'; import it through 'Outer/Inner/Inner.ts', or move it out of 'Outer/Inner' if it is not part of it.",
      },
    ]);
  });

  it("names the index when a directory has two doors", async () => {
    const messages = await lintEntryFixture("entry-two-doors");
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/index.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/entry.test.ts`
Expected: both new tests PASS — Task 4's `findCrossedGate` and `getGates` already implement this, so these pin the behaviour rather than drive it.

Diagnosis if not: reporting `Outer` instead of `Outer/Inner` means `findCrossedGate` walks down from the root instead of up from the target. Reporting `Feature/Feature.ts` in the two-door fixture means the `getGates` tiebreak is inverted. A report on line 1 of `entry-nested-doors` means the `isEntryFile(target)` early return is missing, so a child's door is not being accepted.

- [ ] **Step 3: Fix any failure**

No production change expected. `getGates`'s `!gates.has(dir) || isIndex` branch is what makes the tiebreak test pass; `findCrossedGate`'s early `isEntryFile(target)` return is what keeps `./Outer/Inner/Inner` legal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/entry.test.ts tests/fixtures/entry-nested-doors tests/fixtures/entry-two-doors
git commit -m "test: cover nested doors and the two-door tiebreak"
```

---

### Task 8: Type-only imports and re-export barrels

Type-only imports are treated identically to value imports — a type is part of the surface. A barrel gets no exemption either: re-exporting a private file under a public name launders the violation, which is worse than a direct import because every downstream consumer then looks innocent. Note that `ownership` deliberately does the opposite for barrels; that exemption is about placement, not access.

**Files:**
- Create: `tests/fixtures/entry-type-only/`, `tests/fixtures/entry-reexport-barrel/`
- Modify: `src/rules/entry.ts`, `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-type-only/src/app.ts`:

```ts
import type { Thing } from "./Feature/types";

export const app: Thing = { id: 1 };
```

`tests/fixtures/entry-type-only/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-type-only/src/Feature/types.ts`:

```ts
export interface Thing {
  id: number;
}
```

`tests/fixtures/entry-reexport-barrel/src/app.ts`:

```ts
import { helper } from "./pages";

export const app = helper;
```

`tests/fixtures/entry-reexport-barrel/src/pages/index.ts`:

```ts
export * from "./Feature/helper";
export { named } from "./Feature/named";
```

`tests/fixtures/entry-reexport-barrel/src/pages/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-reexport-barrel/src/pages/Feature/helper.ts`:

```ts
export const helper = 2;
```

`tests/fixtures/entry-reexport-barrel/src/pages/Feature/named.ts`:

```ts
export const named = 3;
```

Add to `tests/entry.test.ts`:

```ts
  // A type is part of the surface, and the graph records no import kind, so
  // there is nothing to exempt even if we wanted to.
  it("reports a type-only import that reaches past an entry", async () => {
    const messages = await lintEntryFixture("entry-type-only");
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/types.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  // No barrel exemption: re-exporting a private file under a public name is a
  // worse leak than importing it directly.
  it("reports a barrel that re-exports past an entry", async () => {
    const messages = await lintEntryFixture("entry-reexport-barrel");
    expect(messages.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/pages/index.ts", line: 1 },
      { file: "src/pages/index.ts", line: 2 },
    ]);
    expect(messages[0].message).toBe(
      "'pages/Feature/helper.ts' is inside module 'pages/Feature'; import it through 'pages/Feature/Feature.ts', or move it out of 'pages/Feature' if it is not part of it.",
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entry.test.ts -t "barrel"`
Expected: FAIL — the barrel test reports nothing, because only `ImportDeclaration` is visited. The type-only test should already PASS: `import type` parses as an `ImportDeclaration`.

- [ ] **Step 3: Write minimal implementation**

In `src/rules/entry.ts`, extend the returned visitor object:

```ts
    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts`
Expected: all PASS.

Run: `npm test && npm run typecheck`
Expected: everything PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/rules/entry.ts tests/entry.test.ts tests/fixtures/entry-type-only tests/fixtures/entry-reexport-barrel
git commit -m "feat: check re-export specifiers, and cover type-only imports"
```

---

### Task 9: Dynamic `import()`, `import =`, and scope-aware `require()`

A boundary you can bypass with `await import("./Feature/helper")` is not a boundary. This mirrors the five edge kinds the graph already collects, including `graph.ts`'s rule that a shadowed `require` is not an edge — except `const require = createRequire(import.meta.url)`, which is the real one.

**Files:**
- Create: `tests/fixtures/entry-dynamic/`, `tests/fixtures/entry-require/`
- Modify: `src/rules/entry.ts`, `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-dynamic/src/app.ts`:

```ts
import lazy = require("./Feature/viaEquals");

export async function load() {
  return import("./Feature/helper");
}

export const eq = lazy;
```

`tests/fixtures/entry-dynamic/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-dynamic/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

`tests/fixtures/entry-dynamic/src/Feature/viaEquals.ts`:

```ts
export const viaEquals = 3;
```

`tests/fixtures/entry-require/src/app.ts` — note the module-level binding is named `require`, so the visitor sees it:

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const real = require("./Feature/helper");

export function shadowed(require: (id: string) => unknown) {
  // Not the CJS require, so not an edge and not a boundary crossing.
  return require("./Feature/helper");
}
```

`tests/fixtures/entry-require/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-require/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

Add to `tests/entry.test.ts`:

```ts
  it("reports dynamic import and import-equals", async () => {
    const messages = await lintEntryFixture("entry-dynamic");
    expect(messages.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/app.ts", line: 1 },
      { file: "src/app.ts", line: 4 },
    ]);
  });

  it("ignores a require shadowed by a parameter", async () => {
    const messages = await lintEntryFixture("entry-require");
    // Only the createRequire-bound call on line 4 is a real require.
    expect(messages.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/app.ts", line: 4 },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entry.test.ts -t "dynamic"`
Expected: FAIL — no messages, since `ImportExpression`, `TSImportEqualsDeclaration` and `CallExpression` are not visited.

- [ ] **Step 3: Write minimal implementation**

In `src/rules/entry.ts`, add above `const rule`:

```ts
// Mirrors graph.ts: a `require` bound in an enclosing scope is not the CJS one,
// so it is not an edge - unless it was bound by createRequire, which is.
function requireIsShadowed(
  sourceCode: { getScope: (node: ESTree.Node) => Scope.Scope },
  node: ESTree.Node,
): boolean {
  let scope: Scope.Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.variables.find((entry) => entry.name === "require");
    if (variable !== undefined) {
      return !variable.defs.some((def) => {
        const declarator = def.node as { type: string; init?: ESTree.Node | null };
        if (declarator.type !== "VariableDeclarator") {
          return false;
        }
        const init = declarator.init;
        return (
          init?.type === "CallExpression" &&
          init.callee.type === "Identifier" &&
          init.callee.name === "createRequire"
        );
      });
    }
    scope = scope.upper;
  }
  return false;
}
```

Add `Scope` to the eslint type import:

```ts
import type { Rule, Scope } from "eslint";
```

Extend the visitor object:

```ts
    return {
      ImportDeclaration(node) {
        checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
      ImportExpression(node) {
        checkSource((node as unknown as { source: ESTree.Node }).source);
      },
      // Not an ESTree node, so it arrives untyped from the TypeScript parser.
      TSImportEqualsDeclaration(node) {
        const reference = (
          node as unknown as {
            moduleReference: { type: string; expression?: ESTree.Node };
          }
        ).moduleReference;
        if (reference.type === "TSExternalModuleReference") {
          checkSource(reference.expression);
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "Identifier" ||
          node.callee.name !== "require" ||
          node.arguments.length !== 1
        ) {
          return;
        }
        if (requireIsShadowed(context.sourceCode, node)) {
          return;
        }
        checkSource(node.arguments[0] as ESTree.Node);
      },
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts`
Expected: all PASS.

Run: `npm test && npm run typecheck`
Expected: everything PASSES. If `ImportExpression` is unknown to the installed `Rule.RuleListener` type, keep the `as unknown as` cast shown above.

- [ ] **Step 5: Commit**

```bash
git add src/rules/entry.ts tests/entry.test.ts tests/fixtures/entry-dynamic tests/fixtures/entry-require
git commit -m "feat: check dynamic import, import-equals and CJS require"
```

---

### Task 10: `ignore` globs and disable comments

The report lands on the specifier node, so a line-level `eslint-disable-next-line` works without the Program-node workaround `ownership` needs.

**Files:**
- Create: `tests/fixtures/entry-ignore/`, `tests/fixtures/entry-disable/`
- Modify: `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-ignore/src/app.ts`:

```ts
import { helper } from "./Feature/helper";

export const app = helper;
```

`tests/fixtures/entry-ignore/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-ignore/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

`tests/fixtures/entry-disable/src/app.ts`:

```ts
// eslint-disable-next-line colocate/entry
import { helper } from "./Feature/helper";

export const app = helper;
```

`tests/fixtures/entry-disable/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-disable/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

Add to `tests/entry.test.ts`:

```ts
  it("says nothing about an ignored target", async () => {
    const messages = await lintEntryFixture("entry-ignore", {
      ignore: ["Feature/helper.ts"],
    });
    expect(messages).toEqual([]);
  });

  it("still reports the same fixture without the ignore glob", async () => {
    const messages = await lintEntryFixture("entry-ignore");
    expect(messages).toHaveLength(1);
  });

  it("honours a line-level eslint-disable comment", async () => {
    const messages = await lintEntryFixture("entry-disable");
    expect(messages).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/entry.test.ts`
Expected: all three new tests PASS. Task 5's `check` already filters the resolved target through `isExcludedPath`, and the disable comment works because the report node sits inside the import statement rather than on `Program`.

Diagnosis if not: an ignored target still reporting means `isExcludedPath` is being applied only to the linted file and not to `targetRel`. The disable comment failing means the report is anchored on the wrong node — `ownership` needs `node.body[0]` precisely because Program-node reports are dropped in ESLint 10, and this rule must not inherit that workaround.

- [ ] **Step 3: Fix any failure**

No production change expected. If the ignore test fails, add the missing `targetRel` guard in `check` rather than filtering in `findCrossedGate` — `gates.ts` deliberately knows nothing about options.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/entry.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/entry.test.ts tests/fixtures/entry-ignore tests/fixtures/entry-disable
git commit -m "test: cover ignore globs, outside-root targets and disable comments"
```

---

### Task 11: Robustness — the rule never throws

Mirrors `robustness.test.ts`'s guarantees for the new rule: a missing root, an unresolvable specifier, and a file not on disk must all produce no findings rather than an exception.

**Files:**
- Create: `tests/fixtures/entry-unresolvable/`, `tests/fixtures/entry-dts-not-a-door/`
- Modify: `tests/entry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixtures/entry-unresolvable/src/app.ts`:

```ts
import { nope } from "./Feature/does-not-exist";
import { pkg } from "some-bare-package";

export const app = { nope, pkg };
```

`tests/fixtures/entry-unresolvable/src/Feature/Feature.ts`:

```ts
export const Feature = 1;
```

`tests/fixtures/entry-dts-not-a-door/src/app.ts`:

```ts
import { helper } from "./Feature/helper";

export const app = helper;
```

`tests/fixtures/entry-dts-not-a-door/src/Feature/index.d.ts`:

```ts
export declare const Feature: number;
```

`tests/fixtures/entry-dts-not-a-door/src/Feature/helper.ts`:

```ts
export const helper = 2;
```

Add to `tests/entry.test.ts`:

```ts
  it("stays silent on unresolvable and bare specifiers", async () => {
    const messages = await lintEntryFixture("entry-unresolvable");
    expect(messages).toEqual([]);
  });

  it("stays silent when root does not exist", async () => {
    const messages = await lintEntryFixture("entry-reaches-past", {
      root: "does-not-exist",
    });
    expect(messages).toEqual([]);
  });

  // Declaration files are excluded from the graph, so an index.d.ts is not a
  // door and the directory it sits in is not a gate.
  it("does not treat a declaration file as an entry", async () => {
    const messages = await lintEntryFixture("entry-dts-not-a-door");
    expect(messages).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/entry.test.ts`
Expected: all three PASS. `resolveSpecifier` returns `undefined` for unresolvable and non-source targets, and `safeRealpath` returns `undefined` for a root that is not on disk.

`collectMessages` throws on a fixture that fails to parse, so a green run here genuinely means "no findings" rather than "no lint".

- [ ] **Step 3: Fix any failure**

If any of these throws rather than reporting nothing, add the missing early return in `create` — do not wrap the body in `try`/`catch`. The codebase's rule is that every filesystem read goes through `src/lib/fs-safe.ts` and degrades to skip.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: everything PASSES.

- [ ] **Step 5: Commit**

```bash
git add tests/entry.test.ts tests/fixtures/entry-unresolvable tests/fixtures/entry-dts-not-a-door
git commit -m "test: entry rule degrades to no findings instead of throwing"
```

---

### Task 12: Documentation and full verification

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 1: Add the consumer documentation**

In `README.md`, update the usage block to show both rules:

```js
import colocate from "eslint-plugin-colocate";

export default [
  {
    plugins: {
      colocate,
    },
    rules: {
      "colocate/ownership": [
        "error",
        {
          root: "src",
          layers: ["src/ui"],
          ignore: ["**/*.generated.ts"],
        },
      ],
      "colocate/entry": ["error", { root: "src" }],
    },
  },
];
```

Then add a new section. The heading must slugify to `#the-entry-rule` to match `meta.docs.url`:

```markdown
## The entry rule

`colocate/ownership` decides where a file belongs. `colocate/entry` decides how you get in.

A directory that contains an **entry file** — one named after the directory (`Feature/Feature.ts`) or an `index` — is a module with a front door. Imports from outside that directory must land on a door. Reaching past every door into the internals is an error.

```
# BAD - reaches past Feature's door
import { helper } from "./Feature/helper";

# GOOD - lands on the door
import { Feature } from "./Feature/Feature";
```

**Nested doors count.** A door belonging to a nested module is a legal landing place, so `pages/Inbox/FilterPanel/FilterPanel.ts` is reachable from anywhere. Only a file that is not a door anywhere is off limits.

**A directory with no entry file is not a module.** It gates nothing, and the rule demands nothing of it — a folder of independent sibling files (`lib/`, `tabs/`) stays as it is. The rule is a ratchet: add a door when a directory deserves one, and from then on it is the only way in.

**Unlike `ownership`, entry points get no exemption.** A file nothing imports is still not allowed to reach past a module's door; a shell that burrows into a feature's internals is exactly the finding worth having.

Options are `root` and `ignore`, with the same meaning as `ownership`. There is no `layers` option: layers are about placement, and say nothing about access. There is no autofix — rewriting a specifier produces code that does not compile whenever the door does not re-export the symbol yet, so widening the door is left to you.
```

- [ ] **Step 2: Update the agent guidance**

In `AGENTS.md`, change the "What this is" line to name both rules, and update the layout block:

```
src/index.ts              plugin export: meta + rules.ownership, rules.entry
src/rules/ownership.ts    ESLint rule: options, reports, singleton/mismatchedEntry
src/rules/entry.ts        ESLint rule: import-boundary reports
src/lib/graph.ts          walk, specifier extract, resolve, graph cache
src/lib/gates.ts          entry detection, gate map, crossed-gate lookup
src/lib/owners.ts         owners, shells, layers, colocation
src/lib/root.ts           resolve a configured root from any working directory
src/lib/fs-safe.ts        every filesystem read: degrade to skip, never throw
```

Add a section after "Ownership model":

```markdown
## Entry model (`colocate/entry`)

Separate rule, separate concept. `ownership` asks where a file belongs; `entry` asks whether an import may cross into a module.

**Gate.** A directory containing an entry file: named after the directory, or `index`. Detection is **structural** — unlike `isOwnerEntryFile`, nothing has to import it. That difference is deliberate: the imported-through condition exists to stop a convenience barrel from redrawing *ownership* boundaries, and a door that gated nothing until consumers had already migrated would never engage.

**Illegal** ⟺ the target is not an entry file **and** some gate contains the target but not the importer. Report on the specifier node, naming the **innermost** such gate (`index` wins when a directory has two doors).

**Nested doors count.** Landing on any entry is legal, including a child module's. This is what makes innermost the right gate to name: any door is a legal terminus, so one report is always one edit, with no cascade.

Options are `{ root, ignore }` only. Do not add `layers` — placement and access are different questions, and conflating them is what the design explicitly rejected.

Invariants: no shell exemption (that is the point of the rule); no barrel exemption for importers, unlike `getColocationConsumers`; type-only imports treated like value imports; no autofix; no check on whether the door re-exports the symbol; never a requirement that a directory *have* an entry.
```

Add to the "Invariants (do not regress)" list:

```markdown
- `colocate/entry` takes no `layers` option and grants no shell or barrel exemption.
- `entry` detection stays structural; do not reuse `isOwnerEntryFile` for it.
```

- [ ] **Step 3: Run the full verification**

```bash
npm test
npm run typecheck
npm run build
npm run check:placement
```

Expected: `npm test` all green; `typecheck` and `build` clean; `check:placement` reports no unsatisfiable configuration. `check:placement` guards the ownership model, which this work does not change — run it anyway because Task 3 touched `graph.ts`.

- [ ] **Step 4: Verify the docs URL anchor resolves**

Run: `grep -n "the-entry-rule" README.md src/rules/entry.ts`
Expected: the `## The entry rule` heading in `README.md` and the `meta.docs.url` in `src/rules/entry.ts`. GitHub slugifies `## The entry rule` to `#the-entry-rule`.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document the entry rule for consumers and agents"
```

---

## Out of scope

The `dap-web` consumer is **not** part of this work — no folder renames, no `EditRequest.tsx`, no `Inbox` cleanup, and no severity change in its config.

Worth recording because it is counter-intuitive: **this rule does not flag the three imports that motivated it.** `dap-web`'s `src/components/pages/EditRequest/` has no entry file, so it is not a gate, so `app/requests/[id]/edit/page.tsx` reaching into it stays silent until someone adds `EditRequest.tsx` or `index.tsx`. That is the ratchet working as designed, not a gap.

For reference, `dap-web` would report roughly 16 findings once the rule ships: 10 in `src/domain` (5 × `@/domain/result`, 5 × `@/domain/ports/types`) and 6 in `pages/Inbox` (4 × `filterParams`, 2 × `InboxList`). Treat 16 as a floor — only `@/`-aliased specifiers were counted, not relative-path crossings.
