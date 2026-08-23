# eslint-plugin-colocate

ESLint (v9+) plugin that flags source files sitting in the wrong place, given who imports them.

A file used by one module belongs inside that module's folder. A file used by several belongs at their closest common ancestor — not buried in one of them, and not floating above them. Empty wrapper folders get flagged too.

## Install

```bash
npm install -D gosukiwi/file-ownership-lint
```

## Usage

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
    },
  },
];
```

## The model

The plugin builds an import graph over `root` and checks that each file's location matches its consumers.

**Owners.** A directory is an owner when it has an entry file: one named after the directory (`pages/MyPage/MyPage.ts`), or an `index` that outside code imports through. A barrel that only groups loose helpers does not make its directory an owner. A file with no such folder around it owns only itself.

**Private files.** Imported by exactly one owner → belong inside that owner's folder.

**Shared files.** Imported by two or more owners → belong at their closest common ancestor, not above it and not inside one of them.

A folder's own entry file is never flagged for sitting in its own folder. If the folder itself is in the wrong place, the folders above it report that.

**The app shell.** Entry points (files nothing imports) and what they import directly do not own those imports. So `main.ts → App.ts → pages/Home/Home.ts` leaves `Home` where it is, with no configuration.

For a longer bootstrap chain (`main → router → App → pages/...`), or a shell that imports loose top-level modules, declare those directories as `layers`.

## Examples

**Private — only `MyPage` imports `helper`**

```
# BAD
src/pages/helper.ts
src/pages/MyPage/MyPage.ts

# GOOD
src/pages/MyPage/MyPage.ts
src/pages/MyPage/helper.ts
```

**Shared — `A` and `B` both import `fmt`**

```
# BAD — buried in one owner
src/pages/A/A.ts
src/pages/A/fmt.ts
src/pages/B/B.ts

# BAD — sitting above their common ancestor
src/fmt.ts
src/pages/A/A.ts
src/pages/B/B.ts

# GOOD — at pages/, the common ancestor
src/pages/fmt.ts
src/pages/A/A.ts
src/pages/B/B.ts
```

**Singleton folder — a wrapper around one file**

```
# BAD
src/Foo/Foo.ts

# GOOD — flatten
src/Foo.ts

# GOOD — or colocate a stylesheet
src/Foo/Foo.ts
src/Foo/Foo.module.css
```

**App shell — `App` imports `Home`; it does not own it**

```
# GOOD
src/main.ts              ← entry (nothing imports it)
src/App.ts               ← imported only by main
src/pages/Home/Home.ts   ← stays a page, not pulled into App
```

**Layers — `layers: ["src/ui"]` makes `Button` a public peer**

```
# GOOD even if only Home imports Button
src/ui/Button/Button.ts
src/pages/Home/Home.ts
```

## Options

### `root`

Directory to walk, and the ceiling for ownership. Default `"."`. Set `"src"` for a typical app.

A relative `root` is resolved from the working directory, then searched upward so `eslint` still works from a subdirectory. The search stops at the nearest `package.json` or `.git`. Files outside `root` are never reported.

### `layers`

Directories whose immediate children are public peers: they may have one consumer or many, and they stay where they are. With `layers: ["src/ui"]`, `src/ui/Button` is not expected to move into the page that uses it.

Only the layer's own files and each child folder's entry (`Button/Button.ts` or `Button/index.ts`) get this treatment. Files deeper in (`ui/Button/internals/state.ts`) are still checked.

This is also how a deeper app shell is described:

```js
layers: ["src", "src/pages"] // top-level modules and pages are public peers
```

### `ignore`

Globs relative to `root`. Ignored files are not reported and do not count as consumers. A glob naming a directory excludes everything under it. Negation (`!`) is not supported — list what to exclude.

Unknown option names are rejected.

## What it reports

| message | meaning | usual fix |
| --- | --- | --- |
| `privateOutsideOwner` | One owner imports this file, and it sits outside that owner's folder. | Move it inside the folder, or convert the owner into a folder with a matching entry file. |
| `sharedTooHigh` | Several owners import it, and it sits above their common ancestor. | Move it down to the common ancestor. |
| `sharedInsideOwner` | Several owners import it, and it sits inside one of theirs. | Hoist it to the common ancestor. |
| `singletonFolder` | A directory holds a single source file and no stylesheet beside it. | Flatten the directory, or colocate something with the file. |
| `mismatchedEntry` | An `index` re-exports exactly one sibling under a different name, and outside code imports the barrel. | Rename the sibling after the folder and drop the barrel, or import the module directly. |

`singletonFolder` looks for a companion stylesheet only in the same directory (`.css`, `.scss`, `.sass`, `.less`, `.styl`).

An `index` that re-exports two or more siblings is a namespace barrel and is left alone.

## Notes

- Resolution uses the TypeScript compiler, so `paths` and `baseUrl` from the nearest `tsconfig.json` are honoured. Extensionless imports and `./x.js` → `x.ts` work the way bundlers do.
- Tests, `node_modules`, `dist`, coverage, VCS dirs, and `.d.ts` files are skipped.
- Code reachable only through an import cycle is not checked. Breaking the cycle restores the reports.
- On a case-insensitive filesystem, config paths (`root: "SRC"` vs `src`) still have to match disk casing.
