# Entry model (`colocate/entry`)

Separate rule, separate concept. `ownership` asks where a file belongs; `entry` asks whether an import may cross into a module.

**Gate.** A directory containing an entry file: named after the directory, or `index`. Detection is **structural** — unlike `isOwnerEntryFile`, nothing has to import it. That difference is deliberate: the imported-through condition exists to stop a convenience barrel from redrawing *ownership* boundaries, and a door that gated nothing until consumers had already migrated would never engage. Do not reuse `isOwnerEntryFile` for entry detection.

**Two kinds of door.** A file named after its folder (`Foo/Foo.ts`) is the shortcut door: the public module is that file. `index.ts` is the barrel door: the public surface may come from more than one file. `index` re-exporting siblings is allowed; a named door identity-re-exporting another source file in the graph is not.

**Illegal crossing** ⟺ the target is not an entry file **and** some gate contains the target but not the importer. Report on the specifier node, naming the **innermost** such gate (`index` wins when a directory has two doors). Message id: `reachesPastEntry`.

**Named door re-export** is a separate finding (`namedDoorReexport`): shape-only — it does not change gates, `isEntryFile`, or `isOwnerEntryFile`. Detection lives in `src/lib/named-door.ts`; `src/rules/entry.ts` is the adapter that reports it. Identity forms: `export … from`, import-then-export, and `require` / `import-equals` as sources. Type-only re-exports are skipped; package specifiers are skipped; wrap-around re-exports (re-exporting through the door again) are silent. CJS `module.exports` is out of scope ([#35](https://github.com/gosukiwi/eslint-plugin-colocate/issues/35)).

**Nested doors count.** Landing on any entry is legal, including a child module's. This is what makes innermost the right gate to name: any door is a legal terminus, so one report is always one edit, with no cascade.

Options are `{ root, ignore }` only. Do not add `layers` — placement and access are different questions, and conflating them is what the design explicitly rejected.

Invariants: no shell exemption (that is the point of the rule); no barrel exemption for importers, unlike `getColocationConsumers`; type-only imports treated like value imports, in both the `import type { T } from "./x"` and the inline `import("./x").T` / `typeof import("./x")` spellings (`TSImportType`, a separate visitor); no autofix; no check on whether the door re-exports the symbol; never a requirement that a directory *have* an entry.

Specifiers must be **statically known**: a quoted string or a template literal with no substitutions. Backticks resolve exactly as quotes do, so leaving them out of `entry` made them a one-character way to launder every crossing past a ratchet rule. The `cooked` value is what gets resolved, not `raw`. Anything else (a substituted template, concatenation, `as string`, an identifier) stays out. Declaration files are outside the model as **targets** as well as doors — `resolveSpecifier`'s probe still finds `types.d.ts` for a `"./types.d"` specifier, so the target is filtered on `isSourceFile`.

The `TSImportType` visitor must read **both** AST shapes: `node.source` exists only from `@typescript-eslint/parser` 8.48, and before that the specifier sits on `node.argument.literal` (a `TSLiteralType`). This plugin declares no parser dependency, so reading `source` alone leaves the visitor silently inert on every 8.x below 8.48 a user may install — inert in exactly the way the visitor was added to fix, and invisible from the outside.

Both the target *and* the importer must be passed through `canonicalGraphPath` before reaching `findCrossedGate`. `realpath` does not fold case, so a wrong-case linted path made `isInsideDir` miss and reported a file for reaching into the directory it lives in — a report whose only fix is a cycle through its own door. Contrast a wrong-case **root**, which produces *no* findings (see [graph](graph.md)).

`entry`'s `CallExpression` visitor narrows to a single-argument `require()`, unlike `parse.ts`, which takes `arguments[0]` at any arity — a real CJS `require` never takes a second argument. Note that this argument cuts the other way too: it is `parse.ts` that should narrow, and until it does, a two-argument `require()` creates a graph edge and so a possible `ownership` report that `entry` will not corroborate. See [known-issues](known-issues.md).

`requireIsShadowed` requires **every** def of a `require` binding to be a `createRequire` call before treating it as the real require. Asking whether *any* def was one is order-blind: `var require = createRequire(url)` followed by `var require = 1` leaves a number at the call site, so it loads nothing. The mirror case (plain first, `createRequire` second) is now a false negative — the right way round for a lint rule, and just as rare, since both need `require` declared twice in one scope.

`scripts/check-placement.ts` treats only `reachesPastEntry` as a crossing for satisfiability; `namedDoorReexport` is ignored there.
