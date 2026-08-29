# AGENTS.md

ESLint 9+ plugin with two rules over the same import graph: `colocate/ownership` (file location vs who depends on it) and `colocate/entry` (imports that reach past a module's entry into its internals). ESM only, Node 20+, TypeScript `module: NodeNext`. Tests import `src/` directly; `npm run build` emits `dist/` for the published package.

Consumer-facing usage lives in `README.md`.

## Commands

```bash
npm test
npm run typecheck
npm run build
npm run check:placement              # not part of npm test; run after ownership-model changes
CONFIGS=40 npm run check:placement   # quicker pass
SEED=<n> npm run check:placement     # reproduce a sweep
```

## Every task

- TypeScript imports use `.js` specifiers (`from "../lib/graph.js"`).
- No code comments. Only humans can add comments.
- Reports stay silent rather than throw. All filesystem reads go through `src/lib/fs-safe.ts`.
- Do not reintroduce a `shells` option or a transitive / wholesale shell exemption.
- `plugin.meta.version` is hardcoded in `src/index.ts`; bump it with `package.json`.
- Do not parse or resolve with a second stack; reuse `parseSourceFile` and `resolveSpecifier`. "Is this file in the model" is `isInGraphScope` in `src/lib/scope.ts` and nowhere else.

## Read when relevant

| If you are… | Read |
| --- | --- |
| Lost, adding a module, or changing how rules talk to the model | [architecture](docs/agents/architecture.md) |
| Changing owners, shells, layers, barrels, consumers, or ownership reports | [ownership](docs/agents/ownership.md) |
| Changing gates, `colocate/entry`, or import-boundary visitors | [entry](docs/agents/entry.md) |
| Changing `root` / `ignore` / `layers` or the options schema | [options](docs/agents/options.md) |
| Changing the walk, resolution, cache, or filesystem degradation | [graph](docs/agents/graph.md) |
| Adding or changing tests or fixtures | [testing](docs/agents/testing.md) |
| About to change the model (do-not-regress checklist) | [invariants](docs/agents/invariants.md) |
| Touching a GitHub issue or a graph/gate bug | [known-issues](docs/agents/known-issues.md) |
