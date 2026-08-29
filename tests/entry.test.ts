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
  // worse leak than importing it directly. The barrel also re-exports two
  // same-directory siblings (a.ts, b.ts) so it qualifies as a namespace
  // barrel under ownership's sibling-scoped predicate - the point is that an
  // isNamespaceBarrel-style exemption here would wrongly swallow both findings.
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
    // Full messages, not just file/line: a weaker assertion would still pass
    // if the two visitors resolved each other's targets by mistake.
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

  it("ignores a require shadowed by a parameter", async () => {
    const messages = await lintEntryFixture("entry-require", { root: "src" });
    // Only the createRequire-bound call on line 4 is a real require.
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

  // Regression test for a bug the first pass of this rule shipped with: an
  // ambient/global `require` (no local declaration at all, which is exactly
  // what a `.cjs` file's default sourceType and most Node ESLint configs
  // give you) resolves to a scope variable with `defs: []`. Treating
  // "no defs" as "shadowed" made the whole CallExpression visitor inert on
  // real CommonJS - the two cases below reproduce that with no override and
  // with an explicit globals.node-style config, confirmed to fail (empty
  // messages) before the `defs.length > 0` guard and pass after.
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
    // No local `require` binding here at all - `require` resolves straight
    // to the ambient global declared via `globals`, the near-universal Node
    // ESLint setup (`globals: globals.node` does the same thing). That
    // global variable has `defs: []`, which the first pass of this rule
    // mistook for "shadowed" and so reported nothing.
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

  // Espree coverage for the dynamic-import and require() visitors, following
  // the eslint-disable-ownership-js precedent: TSImportEqualsDeclaration
  // never fires under Espree, but ImportExpression and the CallExpression
  // require() visitor are plain ESTree/ESLint-scope machinery and must work
  // without the TypeScript parser.
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

  // graph.ts's isCreateRequireCall accepts a property-access callee
  // (`mod.createRequire(...)`), not just a bare identifier import - the rule
  // must recognise the same form or it silently misses a real CJS edge.
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

  // Control for the test above: without it, the previous [] could just mean
  // this fixture never produced a finding in the first place. Pinning the
  // full object (not just a count) is what stops a future change that
  // relocates or renames the finding from still satisfying a weaker
  // assertion here - the same reasoning the dynamic-import test above uses.
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

  // The report lands on the specifier node (not node.body[0] ?? node), so a
  // line-level eslint-disable-next-line works without the Program-node
  // workaround ownership needs there - that workaround exists only because
  // ESLint 10 drops Program-node reports. Because this rule never reports on
  // Program, it also has no need for ownership's Espree disable twin
  // (eslint-disable-ownership-js): the parser choice cannot change which
  // node the report is anchored to.
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

  // resolveRootDir("does-not-exist", cwd) walks up looking for an existing
  // directory, hits the project boundary (nearest package.json/.git) before
  // finding one, and falls back to <fixture>/does-not-exist, which is not on
  // disk - so safeRealpath(rootDir) is undefined and create bails at the
  // *first* guard (realRootDir === undefined). This same input also fails
  // isOutsideRoot (path.relative would read "../src/app.ts"), so this test
  // cannot tell the two guards apart - only statement order decides which
  // one fires first, and this stays green even if the realpath guard were
  // deleted. It also leans on entry-reaches-past reporting exactly the one
  // finding pinned by the first test in this file; a change there would
  // silently change what "stays silent" is silencing.
  it("stays silent when root does not exist", async () => {
    const messages = await lintEntryFixture("entry-reaches-past", {
      root: "does-not-exist",
    });
    expect(messages).toEqual([]);
  });

  // Declaration files are excluded from the graph, so an index.d.ts is not a
  // door and the directory it sits in is not a gate.
  it("does not treat a declaration file as an entry", async () => {
    const messages = await lintEntryFixture("entry-dts-not-a-door", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // Mirrors robustness.test.ts's "linted file is not on disk" case for
  // ownership: --stdin-filename, a processor, or a file deleted mid-run all
  // hand the rule a filename ESLint parsed but that safeRealpath cannot
  // resolve. realFilename is undefined, so create bails at the same guard
  // exercised above by the missing-root case - together the two tests cover
  // both disjuncts of `realRootDir === undefined || realFilename === undefined`.
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

  // `import("./x").T` and `typeof import("./x")` are TSImportType, a different
  // node from ImportExpression, so they reached no visitor at all while the
  // equivalent `import type { T } from "./x"` was gated. The rule's answer must
  // not depend on which spelling the author picked - the ungated one is what
  // generated code and files avoiding top-level imports emit. Line 3 is the
  // negative control: the same inline spelling landing ON the door is legal.
  it("reports an inline type import that reaches past the entry", async () => {
    const messages = await lintEntryFixture("entry-type-import-node", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 1, messageId: "reachesPastEntry" },
      { file: "src/app.ts", line: 2, messageId: "reachesPastEntry" },
    ]);
  });

  // A no-substitution template literal is as static as a quoted string, so
  // leaving it out made backticks a one-character way to launder every crossing
  // in a file past a rule whose entire purpose is a ratchet. The other two lines
  // pin the boundaries of that: line 4 resolves only if the *cooked* value is
  // used (`raw` would leave the p escape in the specifier and resolve
  // nothing), and line 5 must stay out because a substituted template is not
  // statically known.
  it("reports a static template-literal specifier and ignores a substituted one", async () => {
    const messages = await lintEntryFixture("entry-template-specifier", {
      root: "src",
    });
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 3, messageId: "reachesPastEntry" },
      { file: "src/app.ts", line: 4, messageId: "reachesPastEntry" },
    ]);
  });

  // Complements entry-dts-not-a-door, which pins that a .d.ts is not a *door*.
  // This pins that it is not a *target* either: resolveSpecifier's own probe
  // still finds types.d.ts for a "./types.d" specifier, and reporting it named
  // a door that will never re-export the type.
  it("does not report a declaration file as a target", async () => {
    const messages = await lintEntryFixture("entry-dts-target", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // `var require = createRequire(url)` followed by `var require = 1` leaves
  // `require` holding a number at the call, so the call loads nothing and there
  // is no crossing to report. Checking whether *any* def was a createRequire
  // was order-blind and reported one.
  it("stays silent when a createRequire binding is later clobbered", async () => {
    const messages = await lintEntryFixture("entry-require-redeclared", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // The deliberate cost of the check above, recorded so a future reader does not
  // read this silence as the order-blind bug coming back: here `require` really
  // is the real one at the call, and requiring *every* def to be a createRequire
  // call gives up the finding. Accepted because a missed report beats a wrong
  // one, and because both shapes need `require` declared twice in one scope.
  it("gives up the finding when a clobbered require is later reassigned (known false negative)", async () => {
    const messages = await lintEntryFixture("entry-require-redeclared-mirror", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // Forces findCrossedGate's upward walk to iterate: the target's own directory
  // (Feature/utils) is not a gate, so the gate is only found one level further
  // up. Every other fixture puts the target directly inside its gate, which the
  // first iteration already answers, so nothing pinned the loop - even though
  // this is the README's headline case. Asserts the whole message, which ties
  // target, module and entry together.
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

  // Featurex is not inside Feature, and the only thing keeping them apart is the
  // trailing separator in isInsideDir's comparison. Dropping it would make a
  // prefix-sharing sibling look like it lives inside the gate and silently lose
  // this report. The message is asserted too, so the named module cannot drift.
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

  // The rule resolves specifiers with the graph's own settings, which is what
  // carries the project's `paths`. Losing them would fall back to a lenient
  // default with no `paths` at all, so every aliased import would resolve to
  // nothing and the rule would go quiet without anything looking broken. The
  // fixture's own tsconfig.json is what makes `@/` resolve - no other entry
  // fixture has one, so nothing else covers aliased resolution.
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

  // The shadowing binding is a parameter of an enclosing function and the call
  // sits in a nested arrow, so only a walk up the scope chain finds it - an
  // immediate-scope-only check would report this.
  it("stays silent for a require shadowed in an enclosing scope", async () => {
    const messages = await lintEntryFixture("entry-require-nested-scope", {
      root: "src",
    });
    expect(messages).toEqual([]);
  });

  // The mirror case, and the one graph.ts gets wrong (see
  // docs/agents/known-issues.md): an inner `const require = createRequire(...)`
  // IS the real require even though an unrelated plain `require` exists in an
  // outer scope. Shadowing is lexical, not sticky - the nearest binding decides.
  it("reports an inner createRequire beneath an outer shadowed require", async () => {
    const messages = await lintEntryFixture(
      "entry-require-inner-createrequire",
      { root: "src" },
    );
    expect(pick(messages, "file", "line", "messageId")).toEqual([
      { file: "src/app.ts", line: 5, messageId: "reachesPastEntry" },
    ]);
  });

  // The importer needs the graph's casing for the same reason the target does:
  // realpath does not fold case, so a wrong-case linted path left isInsideDir
  // comparing it against the gate's real key. It missed, and the file was
  // reported for reaching into the very directory it lives in - a report whose
  // only "fix" is to import its own door, i.e. a cycle. Note the contrast with a
  // wrong-case *root*, which is documented to produce no findings; this produced
  // wrong ones.
  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "stays silent when the importer is linted through a wrong-case path",
    async () => {
      const cwd = path.join(
        fileURLToPath(new URL(".", import.meta.url)),
        "fixtures/entry-importer-inside-ok",
      );
      // Feature/Feature.ts imports its own sibling ./helper, so it is inside the
      // gate and must never be reported - however the path reaching the rule is
      // spelled.
      const results = await makeESLint(cwd, { root: "src" }, {
        rule: "entry",
      }).lintFiles(["src/feature/Feature.ts"]);
      expect(collectRuleMessages(cwd, results, "entry")).toEqual([]);
    },
  );
});
