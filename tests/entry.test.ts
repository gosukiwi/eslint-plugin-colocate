import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import {
  collectRuleMessages,
  lintEntryFixture,
  makeESLint,
  pick,
} from "./helpers/lint-fixture.js";

describe("entry rule", () => {
  it("reports an import that reaches past a module's entry", async () => {
    const messages = await lintEntryFixture("entry-reaches-past", {
      root: "src",
    });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("allows an import that lands on the entry", async () => {
    const messages = await lintEntryFixture("entry-through-door-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("rejects unknown options", async () => {
    await expect(
      lintEntryFixture("entry-through-door-ok", { roots: "src" }),
    ).rejects.toThrow();
  });

  it("takes only root and ignore", () => {
    const schema = plugin.rules.entry.meta?.schema;
    const first = Array.isArray(schema)
      ? (schema[0] as {
          additionalProperties: boolean;
          properties: Record<string, unknown>;
        })
      : undefined;
    expect(first?.additionalProperties).toBe(false);
    expect(Object.keys(first?.properties ?? {}).sort()).toEqual([
      "ignore",
      "root",
    ]);
  });

  it("offers no autofix", () => {
    expect(plugin.rules.entry.meta?.fixable).toBeUndefined();
  });

  it("allows a bare directory specifier that resolves to the index", async () => {
    const messages = await lintEntryFixture("entry-index-door-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("allows a module's own files to import each other", async () => {
    const messages = await lintEntryFixture("entry-importer-inside-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("says nothing about a directory with no entry file", async () => {
    const messages = await lintEntryFixture("entry-no-door-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("allows a child's door and names the innermost gate", async () => {
    const messages = await lintEntryFixture("entry-nested-doors", {
      root: "src",
    });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 2,
        message:
          "'Outer/Inner/deep.ts' is inside module 'Outer/Inner'; import it through 'Outer/Inner/Inner.ts', or move it out of 'Outer/Inner' if it is not part of it.",
      },
    ]);
  });

  it("names the index when a directory has two doors", async () => {
    const messages = await lintEntryFixture("entry-two-doors", {
      root: "src",
    });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/index.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports a type-only import that reaches past an entry", async () => {
    const messages = await lintEntryFixture("entry-type-only", { root: "src" });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/types.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports a barrel that re-exports past an entry", async () => {
    const messages = await lintEntryFixture("entry-reexport-barrel", {
      root: "src",
    });
    expect(messages).toEqual([
      {
        file: "src/pages/index.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'pages/Feature/helper.ts' is inside module 'pages/Feature'; import it through 'pages/Feature/Feature.ts', or move it out of 'pages/Feature' if it is not part of it.",
      },
      {
        file: "src/pages/index.ts",
        messageId: "reachesPastEntry",
        line: 2,
        message:
          "'pages/Feature/named.ts' is inside module 'pages/Feature'; import it through 'pages/Feature/Feature.ts', or move it out of 'pages/Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports dynamic import and import-equals", async () => {
    const messages = await lintEntryFixture("entry-dynamic", { root: "src" });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/viaEquals.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 4,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports dynamic import nested in lazy(() => import())", async () => {
    const messages = await lintEntryFixture("entry-lazy-import", { root: "src" });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("ignores a require shadowed by a parameter", async () => {
    const messages = await lintEntryFixture("entry-require", { root: "src" });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 4,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports a require() call with no config override at all (.cjs default sourceType)", async () => {
    const cwd = path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/entry-require-cjs-default",
    );
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      overrideConfig: [
        {
          plugins: { colocate: plugin },
          rules: { "colocate/entry": ["error", { root: "src" }] },
        },
      ],
    });
    const results = await eslint.lintFiles(["src"]);
    const messages = collectRuleMessages(cwd, results, "entry");
    expect(messages).toEqual([
      {
        file: "src/app.cjs",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.cjs' is inside module 'Feature'; import it through 'Feature/Feature.cjs', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports a require() call under an explicit require global (globals.node style)", async () => {
    const cwd = path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/entry-require-node-globals",
    );
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
          languageOptions: {
            parser: tsParser,
            parserOptions: { sourceType: "module", ecmaVersion: 2022 },
            globals: { require: "readonly", module: "readonly" },
          },
          plugins: { colocate: plugin },
          rules: { "colocate/entry": ["error", { root: "src" }] },
        },
      ],
    });
    const results = await eslint.lintFiles(["src/app.ts"]);
    const messages = collectRuleMessages(cwd, results, "entry");
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports dynamic import and require() under Espree", async () => {
    const messages = await lintEntryFixture(
      "entry-dynamic-espree",
      { root: "src" },
      ["src"],
      { parser: "espree" },
    );
    expect(messages).toEqual([
      {
        file: "src/app.js",
        messageId: "reachesPastEntry",
        line: 6,
        message:
          "'Feature/helper.js' is inside module 'Feature'; import it through 'Feature/Feature.js', or move it out of 'Feature' if it is not part of it.",
      },
      {
        file: "src/app.js",
        messageId: "reachesPastEntry",
        line: 9,
        message:
          "'Feature/helper.js' is inside module 'Feature'; import it through 'Feature/Feature.js', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("recognises require bound via a property-access createRequire call", async () => {
    const messages = await lintEntryFixture(
      "entry-require-createrequire-member",
      { root: "src" },
    );
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 5,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("says nothing about an ignored target", async () => {
    const messages = await lintEntryFixture("entry-ignore", {
      root: "src",
      ignore: ["Feature/helper.ts"],
    });
    expect(messages).toEqual([]);
  });

  it("still reports the same fixture without the ignore glob", async () => {
    const messages = await lintEntryFixture("entry-ignore", { root: "src" });
    expect(messages).toEqual([
      {
        file: "src/app.ts",
        messageId: "reachesPastEntry",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("honours a line-level eslint-disable comment", async () => {
    const messages = await lintEntryFixture("entry-disable", { root: "src" });
    expect(messages).toEqual([]);
  });

  it("stays silent on unresolvable and bare specifiers", async () => {
    const messages = await lintEntryFixture("entry-unresolvable", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("stays silent when root does not exist", async () => {
    const messages = await lintEntryFixture("entry-reaches-past", {
      root: "does-not-exist",
    });
    expect(messages).toEqual([]);
  });

  it("does not treat a declaration file as an entry", async () => {
    const messages = await lintEntryFixture("entry-dts-not-a-door", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("stays silent when the linted file is not on disk", async () => {
    const cwd = path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/entry-reaches-past",
    );
    const results = await makeESLint(cwd, { root: "src" }, {
      rule: "entry",
    }).lintText('import { helper } from "./Feature/helper";\n', {
      filePath: path.join(cwd, "src/ghost.ts"),
    });
    expect(collectRuleMessages(cwd, results, "entry")).toEqual([]);
  });

  it("reports an inline type import that reaches past the entry", async () => {
    const messages = await lintEntryFixture("entry-type-import-node", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 1, messageId: "reachesPastEntry" },
      { file: "src/app.ts", line: 2, messageId: "reachesPastEntry" },
    ]);
  });

  it("reports a static template-literal specifier and ignores a substituted one", async () => {
    const messages = await lintEntryFixture("entry-template-specifier", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 3, messageId: "reachesPastEntry" },
      { file: "src/app.ts", line: 4, messageId: "reachesPastEntry" },
    ]);
  });

  it("does not report a declaration file as a target", async () => {
    const messages = await lintEntryFixture("entry-dts-target", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("stays silent when a createRequire binding is later clobbered", async () => {
    const messages = await lintEntryFixture("entry-require-redeclared", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("gives up the finding when a clobbered require is later reassigned (known false negative)", async () => {
    const messages = await lintEntryFixture("entry-require-redeclared-mirror", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("reports a target several levels below the door", async () => {
    const messages = await lintEntryFixture("entry-deep-past-door", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "message")).toEqual([
      {
        file: "src/app.ts",
        line: 1,
        message:
          "'Feature/utils/deep.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports an importer in a sibling directory sharing a name prefix", async () => {
    const messages = await lintEntryFixture("entry-sibling-prefix", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "message")).toEqual([
      {
        file: "src/Featurex/importer.ts",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("reports through a tsconfig paths alias", async () => {
    const messages = await lintEntryFixture("entry-paths-alias", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "message")).toEqual([
      {
        file: "src/app.ts",
        line: 1,
        message:
          "'Feature/helper.ts' is inside module 'Feature'; import it through 'Feature/Feature.ts', or move it out of 'Feature' if it is not part of it.",
      },
    ]);
  });

  it("stays silent for a require shadowed in an enclosing scope", async () => {
    const messages = await lintEntryFixture("entry-require-nested-scope", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("reports an inner createRequire beneath an outer shadowed require", async () => {
    const messages = await lintEntryFixture(
      "entry-require-inner-createrequire",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 5, messageId: "reachesPastEntry" },
    ]);
  });

  it("reports a named door that re-exports a sibling", async () => {
    const messages = await lintEntryFixture("entry-named-door-reexport", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that re-exports with export * from", async () => {
    const messages = await lintEntryFixture("entry-named-door-reexport-star", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that re-exports with export * as ns from", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-reexport-star-as",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that re-exports a nested in-graph file", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-reexport-nested",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/nested/deep.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("allows an index door to re-export siblings", async () => {
    const messages = await lintEntryFixture("entry-index-reexport-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  it("reports a named door that identity-exports an import binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-import-export", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that identity-exports an import binding under another name", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-import-export-as",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that default-exports an import binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-export-default", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that exports a const alias of an import binding", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-export-const-alias",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that identity-exports a require binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-require-export", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that default-exports a require call", async () => {
    const messages = await lintEntryFixture("entry-named-door-require-default", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that default-exports an import-equals binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-import-equals", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 2,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that identity-exports a createRequire binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-createrequire", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 4,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("reports a named door that re-exports a value from a mixed export-from", async () => {
    const messages = await lintEntryFixture("entry-named-door-mixed", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
    ]);
    expect(messages[0]?.message).toBe(
      "Named door 'Foo/Foo.ts' re-exports 'Foo/sib.ts'; use an index.ts in the same folder for a multi-file public surface, or export only what this file declares.",
    );
  });

  it("allows a named door that only re-exports types", async () => {
    const messages = await lintEntryFixture("entry-named-door-type-only-ok", {
      root: "src",
    });
    expect(
      pick(messages, "file", "line", "messageId").filter(
        (message) => message.messageId === "namedDoorReexport",
      ),
    ).toEqual([]);
  });

  it("allows a named door that re-exports a package binding", async () => {
    const messages = await lintEntryFixture("entry-named-door-package-ok", {
      root: "src",
    });
    expect(
      pick(messages, "file", "line", "messageId").filter(
        (message) => message.messageId === "namedDoorReexport",
      ),
    ).toEqual([]);
  });

  it("allows a named door that wraps an import binding before export", async () => {
    const messages = await lintEntryFixture("entry-named-door-wrap-ok", {
      root: "src",
    });
    expect(
      pick(messages, "file", "line", "messageId").filter(
        (message) => message.messageId === "namedDoorReexport",
      ),
    ).toEqual([]);
  });

  it("allows a named door that uses a shadowed require", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-require-shadowed-ok",
      { root: "src" },
    );
    expect(
      pick(messages, "file", "line", "messageId").filter(
        (message) => message.messageId === "namedDoorReexport",
      ),
    ).toEqual([]);
  });

  it("reports both named door re-export and reaches past entry on one file", async () => {
    const messages = await lintEntryFixture(
      "entry-named-door-reexport-past-entry",
      { root: "src" },
    );
    expect(
      pick(messages, "file", "line", "messageId").sort((left, right) =>
        left.messageId === right.messageId
          ? left.line - right.line
          : left.messageId.localeCompare(right.messageId),
      ),
    ).toEqual([
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "namedDoorReexport",
      },
      {
        file: "src/Foo/Foo.ts",
        line: 1,
        messageId: "reachesPastEntry",
      },
    ]);
  });

  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "stays silent when the importer is linted through a wrong-case path",
    async () => {
      const cwd = path.join(
        fileURLToPath(new URL(".", import.meta.url)),
        "fixtures/entry-importer-inside-ok",
      );
      const results = await makeESLint(cwd, { root: "src" }, {
        rule: "entry",
      }).lintFiles(["src/feature/Feature.ts"]);
      expect(collectRuleMessages(cwd, results, "entry")).toEqual([]);
    },
  );
});
