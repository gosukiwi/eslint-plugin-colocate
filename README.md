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

- **`root`** — directory walked to build the import graph. Default `"src"`.
- **`layers`** — globs for layer directories. Immediate children are public peer owners: they may have a single consumer and may sit beside the trees that import them.
- **`ignore`** — extra globs skipped as both subjects and consumers.

With `layers: ["src/ui"]`, a module such as `src/ui/Button` may be imported by one or many pages and stays under the UI layer. `src/pages` is a normal tree: a private helper of one page must live inside that page's folder, not beside it.
