# Options

Schema: `{ root?: string, ignore?: string[], layers?: string[] }`, `additionalProperties: false`. Unknown names must stay rejected. This is the `colocate/ownership` schema. `colocate/entry` takes `{ root, ignore }` only — do not add `layers` to it.

## `root`

Directory walked for the graph, and the ceiling of the ownership walk. Default `"."`. Relative `root` is resolved against `cwd`, then walked **upward** until the directory exists, stopping at the nearest `package.json` or `.git`. Unbounded walk would resolve `src` to an unrelated parent named `src`. Files outside `root` are never reported.

Config/ESLint **paths** (`root`, linted filename) stay case-sensitive — `root: "SRC"` when the dir is `src` produces no findings.

## `layers`

Ownership only. Globs for layer directories. Matched against paths relative to **both** `root` and `cwd` (so `["src/ui"]` and `["ui"]` both work with `root: "src"`). Memoised on the graph; a rebuilt graph recomputes (a new layer dir used to stay invisible until ESLint restarted).

A layer's **immediate children** are public peer owners: they may have one consumer and may sit beside trees that import them. That means files **directly in** the layer directory, plus each child folder's entry (`Button/Button.ts` or `Button/index.ts`). Deeper files are checked normally.

Declaring a layer gives up private-file reporting for those children. That is the intended trade: a public peer with one consumer is indistinguishable from a file that should have been private.

`layers: ["*"]` matches every top-level directory under `root`. Do not treat that as a no-op.

A layer directory created mid-session is picked up because it rebuilds the graph — but only once a file *inside it* is the one being linted, which is a tracked issue rather than intended behaviour.

## `ignore`

Globs relative to `root`. Ignored files are neither reported nor counted as consumers, and do not populate the singleton-folder check. A glob naming a directory excludes everything under it (`["gen"]` ≡ `["gen/**"]`). Symlinks are checked under the link path **and** the real path.

No negation: each glob is independent, so `["!gen"]` matches everything except `gen` and silently disables the rule. List exclusions only.

For `colocate/entry`, `ignore` does more than silence: gates are derived from `graph.files`, so ignoring a **door** removes the gate and legalises every existing reach past it. That inverts the ratchet, and it is not what "not reported, not counted as a consumer" leads a reader to expect — check whether a glob covers an entry file before adding it.
