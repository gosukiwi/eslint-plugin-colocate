# Known issues

**Tracked as GitHub issues, not here.** See the open issues on `gosukiwi/eslint-plugin-colocate`. That split is deliberate: this section drifted out of sync with the tracker once already, and a defect list maintained in two places is a defect list maintained in neither. Before touching one, read the issue and check its **landing note** — whether the fix adds warnings, removes them, or neither. Several are deliberately unfixed because fixing them changes what real projects report.

Load-bearing split-brains (two halves of the model that disagree on one input) belong in [graph](graph.md) and [entry](entry.md), not as a copy of the tracker. Issue numbers there are pointers, not a second issue list.

Two things generalise across all of them, and are the reason a defect here is rarely as narrow as it looks:

- **The graph is the only surface `colocate/ownership` consumes.** `entry` computes its verdict from its own AST walk plus `graph.files` — gates never read `graph.importers` — so a bad `require` edge is invisible to `entry` and load-bearing for `ownership`. "The rule handles scope better than the graph does" is never a reason a graph-level bug is harmless: each spurious edge is a potential wrong `ownership` report, and each missing edge a lost one.
- **Do not assume a gate-model bug is `entry`-only.** `owners.ts`'s `isOwnerEntryFile` repeats the same `basename(file, extname(file)) === basename(dir)` comparison that `gates.ts`'s `isEntryFile` does, so anything that breaks "this file is its directory's entry" destroys the folder *owner* as well as the gate, and invents false `ownership` positives. Two filed issues were originally mis-scoped as entry-only for exactly this reason.
