import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { lintEntryFixture } from "./helpers/lint-fixture.js";

describe("entry rule", () => {
  // src/app.ts is an entry point: nothing imports it, so the ownership model
  // would treat it as shell and exempt what it imports. This rule must not -
  // a shell burrowing into a feature's internals is the finding worth having.
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

  // The schema itself is asserted directly below; this exercises the
  // behaviour that schema enables - ESLint actually rejecting an unknown
  // option - the way ownership.test.ts does for the ownership rule.
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

  // Rewriting a specifier produces code that does not compile whenever the door
  // does not re-export the symbol, which is the common case.
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

  // The ratchet: a folder with no entry is not a gate, so nothing is demanded
  // of it. Adding a door later is what turns the boundary on.
  it("says nothing about a directory with no entry file", async () => {
    const messages = await lintEntryFixture("entry-no-door-ok", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // Landing on any entry file is legal, including a nested module's own -
  // you need not enter through the outermost door. Only the reach past
  // every door is reported, and it names Inner, the innermost gate, because
  // that is the one-edit fix.
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

  // A type is part of the surface, and the graph records no import kind, so
  // there is nothing to exempt even if we wanted to.
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

  // No barrel exemption: re-exporting a private file under a public name is a
  // worse leak than importing it directly.
  it("reports a barrel that re-exports past an entry", async () => {
    const messages = await lintEntryFixture("entry-reexport-barrel", { root: "src" });
    expect(messages.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "src/pages/index.ts", line: 1 },
      { file: "src/pages/index.ts", line: 2 },
    ]);
    expect(messages[0].message).toBe(
      "'pages/Feature/helper.ts' is inside module 'pages/Feature'; import it through 'pages/Feature/Feature.ts', or move it out of 'pages/Feature' if it is not part of it.",
    );
  });
});
