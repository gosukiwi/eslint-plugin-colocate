# file-ownership-lint

ESLint 9 plugin that flags source files whose placement breaks dependency-ownership layout.

## Install

```bash
npm install -D gosukiwi/file-ownership-lint
```

Requires ESLint 9 or later (peer dependency).

## Usage

```js
import fileOwnershipLint from "file-ownership-lint";

export default [
  {
    plugins: {
      "file-ownership-lint": fileOwnershipLint,
    },
    rules: {
      "file-ownership-lint/ownership": [
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

The plugin builds an import graph over `root` and asks, for each file, *who
depends on me, and does my location reflect that?*

**Owners.** A directory is an owner when it contains a file named after itself —
`pages/MyPage/MyPage.ts` makes `pages/MyPage/` an owner. A file with no such
folder around it owns only itself.

**Private files.** A file imported by exactly one owner belongs inside that
owner's folder.

**Shared files.** A file imported by two or more owners belongs at their closest
common ancestor directory — not above it, and not tucked inside one of them.

**The app shell.** Entry points (files nothing imports) and whatever they import
directly are treated as shell: what a shell imports, it does not own. So
`main.ts -> App.ts -> pages/Home/Home.ts` leaves `Home` where it is, with no
configuration. Entry points are detected per import cycle, so a `main <-> App`
cycle or a self-import still yields a shell rather than flagging the project.

For a longer bootstrap chain — `main -> router -> App -> pages/...` — or a shell
that imports loose top-level modules, declare what it reaches as a layer (see
below). There is no option to exempt a shell's imports wholesale, because that
would also hide a shell reaching past a feature's entry into its internals, which
is a real finding.

## Options

### `root`

Directory walked to build the import graph, and the ceiling for the ownership
walk. Default `"."` (the working directory), so a project keeping its sources at
the repository root works unconfigured. Set it to `"src"` for a tighter, faster
graph.

Files outside `root` are never reported on.

### `layers`

Globs for layer directories, matched against paths relative to either `root` or
the working directory, so `["src/ui"]` and `["ui"]` both work with `root: "src"`.

A layer's **immediate children** are public peer owners: they may have a single
consumer and may sit beside the trees that import them. With `layers: ["src/ui"]`,
`src/ui/Button` may be imported by one page or by ten and stays where it is.

"Immediate children" means files directly in the layer directory, plus each child
folder's entry file — `Button/Button.ts` or `Button/index.ts`. Anything deeper is
checked normally: `ui/Button/internals/state.ts` is still expected to sit with
whoever owns it.

Declaring a layer gives up ownership reporting for those children. A page
privately imported by one other page is no longer flagged, exactly as a `Button`
used by a single page is not. That is what the declaration says, and it is the
honest trade: nothing distinguishes "public peer that happens to have one
consumer" from "should have been private".

This is also how deeper app shells are described:

```js
layers: ["src", "src/pages"] // top-level modules and pages are public peers
```

### `ignore`

Extra globs, relative to `root`, skipped as subjects and as consumers: an ignored
file is neither reported nor counted when deciding who owns what. Ignored files
also do not count toward the single-file-directory check.

Unknown option names are rejected rather than silently ignored.

## What it reports

| message | meaning | usual fix |
| --- | --- | --- |
| `privateOutsideOwner` | One owner imports this file, and it sits outside that owner's folder. | Move it inside the folder, or convert the owner into a folder with a matching entry file. |
| `sharedTooHigh` | Several owners import it, and it sits above their common ancestor. | Move it down to the common ancestor. |
| `sharedInsideOwner` | Several owners import it, and it sits inside one of theirs. | Hoist it to the common ancestor. |
| `singletonFolder` | A directory holds a single source file and no stylesheet beside it. | Flatten the directory, or colocate something with the file. |
| `mismatchedEntry` | An `index` re-exports exactly one sibling under a different name, and outside code imports the barrel. | Rename the sibling after the folder and drop the barrel, or import the module directly. |

`singletonFolder` counts source files recursively but looks for a companion
stylesheet only in the same directory — `.css`, `.scss`, `.sass`, `.less` or
`.styl`. A stylesheet three directories down is not a companion.

An `index` re-exporting two or more siblings is a namespace barrel: it is left
alone, and it does not count as a consumer of what it re-exports. An `index`
re-exporting its own directory's named entry (`Foo/index.ts` → `Foo/Foo.ts`) is
also left alone.

## Module resolution

Resolution goes through the TypeScript compiler, so `paths` and `baseUrl` from the
nearest `tsconfig.json` are honoured, including mappings inherited through
`extends`. Resolution is deliberately bundler-style regardless of what the project
sets for `tsc`: extensionless imports resolve, and `./x.js` resolves onto `x.ts`.

Graph edges come from `import`, `export ... from`, dynamic `import()`,
`require()` and `import x = require()`.

Symlinked files and directories inside the tree are followed. On a
case-insensitive filesystem, an import whose case does not match the file on disk
still resolves, matching what the compiler and your bundler do.

Skipped everywhere: `node_modules`, `dist`, `coverage`, `.git`, `.hg`, `.svn`,
declaration files (`.d.ts`, `.d.mts`, `.d.cts`), and tests — any path containing a
`__tests__` segment or a `.test.` / `.spec.` basename.

## Behaviour in a long-lived process

The import graph is cached per `root` + `ignore` for the life of the ESLint
process, and revalidated once per lint pass: an edit, addition or deletion
anywhere in the tree is picked up, so a report clears as soon as you fix the file
that caused it, not just the file being reported. Changes to `tsconfig.json` — and
to any config it extends — invalidate it too.

Filesystem access degrades to "skip" rather than throwing. A `root` that does not
exist, a linted path that is not on disk (editor buffers, processors,
`--stdin-filename`, a file deleted mid-run), or an unreadable directory produces
no findings instead of aborting your lint run.
