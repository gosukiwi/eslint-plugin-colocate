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
- **`layers`** — globs for layer directories. Immediate children are public peer owners: they may have a single consumer and may sit beside the trees that import them.
- **`shells`** — globs (relative to `root`) for app-shell files: entry points,
  routers, and the composition layer. A shell's imports do not make it an owner,
  so pages it pulls in stay where they are.

  By default the plugin infers the shell as the graph's entry points plus what
  they import directly. That covers `main -> App -> pages/...`, but a longer
  bootstrap chain such as `main -> router -> App -> pages/...` needs the option:
  `shells: ["src/*.ts"]`. The inference cannot be extended further on its own —
  `main -> App -> MyPage.ts -> helper.ts` is structurally identical to a
  three-hop bootstrap chain, and there `MyPage.ts` genuinely owns `helper.ts`.
- **`ignore`** — extra globs skipped as both subjects and consumers.

Unknown option names are rejected rather than ignored.

A directory holding a single source file is only exempt from `singletonFolder`
when a stylesheet sits beside that file — `.css`, `.scss`, `.sass`, `.less` or
`.styl`.

With `layers: ["src/ui"]`, a module such as `src/ui/Button` may be imported by one or many pages and stays under the UI layer. `src/pages` is a normal tree: a private helper of one page must live inside that page's folder, not beside it.
