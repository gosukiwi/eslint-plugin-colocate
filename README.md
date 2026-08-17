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

### Options

- **`root`** — directory walked to build the import graph, and the ceiling for
  the ownership walk. Default `"."` (the working directory), so projects that
  keep sources at the repository root work without configuration. Set it to
  `"src"` (or wherever your sources live) for a tighter, faster graph. Files
  outside `root` are never reported on.
- **`layers`** — globs for layer directories, matched against paths relative to
  either `root` or the working directory. Immediate children are public peer
  owners: they may have a single consumer and may sit beside the trees that
  import them. "Immediate children" means files directly in the layer directory,
  plus each child folder's entry file (`Button/Button.ts` or `Button/index.ts`).
  Anything deeper is still checked normally.

  This is also how you describe an app shell. The plugin treats the graph's entry
  points and what they import directly as shell, so `main -> App -> pages/...`
  needs no configuration. A longer bootstrap chain, or a shell that imports loose
  top-level modules, is expressed by declaring what it reaches:

  ```js
  layers: ["src", "src/pages"]   // top-level modules and pages are public peers
  ```

  Declaring a directory a layer gives up ownership reporting for its immediate
  children — a page privately imported by one other page is no longer flagged,
  the same way a `ui/Button` used by a single page is not. That is the point of
  the declaration, and it is the honest trade: there is no signal that separates
  "public peer that happens to have one consumer" from "should have been
  private".

  Note what stays reported: a module shared between the shell and a feature's own
  tree, sitting inside that feature, is still `sharedInsideOwner`. Hoist it to
  their common ancestor rather than silencing it.

- **`ignore`** — extra globs skipped as both subjects and consumers.

Unknown option names are rejected rather than ignored.

A directory holding a single source file is only exempt from `singletonFolder`
when a stylesheet sits beside that file — `.css`, `.scss`, `.sass`, `.less` or
`.styl`.

With `layers: ["src/ui"]`, a module such as `src/ui/Button` may be imported by one or many pages and stays under the UI layer. `src/pages` is a normal tree: a private helper of one page must live inside that page's folder, not beside it.
