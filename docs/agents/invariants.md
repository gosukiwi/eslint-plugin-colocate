# Invariants (do not regress)

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
- `isInsideDir` has **exactly one** implementation, `src/lib/paths.ts`. Do not reintroduce a local copy.
- "Is this path in the model" is `isInGraphScope` in `src/lib/scope.ts`; the rule-side preamble is `resolveSubject` in `src/lib/subject.ts`. Use `subject.covers` for a resolved target.
- Three `Subject` asymmetries must survive tidying: `rootDir` is not realpathed; the linted file is not extension-tested again after realpath; `lintedPath` is only for `mismatchedEntry`. Details: [architecture](architecture.md).
- Every per-graph derived index goes through `derivedFromGraph`. Ask `graphHasFile`, never `new Set(graph.files)` per lint. Ask `graphFilesInDir` for files in a directory, never `graph.files.some/filter` by `path.dirname`.
- `canonicalGraphPath` is applied at the `entry` importer/target and at `collectReExports` only. Do not spread it as a general rule. Details: [graph](graph.md).
- The `getGraph` elapsed-time bound (`REVALIDATE_AFTER_MS`) is load-bearing and must not be dropped. Details: [graph](graph.md).
- Every report must be fixable. `check:placement` guards that. Do not delete or sort `two-findings-one-file`.
