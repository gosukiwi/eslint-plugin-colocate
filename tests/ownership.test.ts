import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { lintFixture } from "./helpers/lint-fixture.js";

function sortMessages(
  messages: { file: string; messageId: string }[],
): { file: string; messageId: string }[] {
  return [...messages].sort((a, b) => {
    const fileOrder = a.file.localeCompare(b.file);
    return fileOrder !== 0 ? fileOrder : a.messageId.localeCompare(b.messageId);
  });
}

describe("ownership rule", () => {
  it("reports singletonFolder when a directory has one source file and no CSS", async () => {
    const messages = await lintFixture("singleton-flag");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report singletonFolder when a CSS file is present", async () => {
    const messages = await lintFixture("singleton-css-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report singletonFolder for a standalone flat source file", async () => {
    const messages = await lintFixture("singleton-flat-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report singletonFolder when a companion stylesheet is not CSS", async () => {
    const messages = await lintFixture("singleton-scss-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports singletonFolder when the only stylesheet sits in a nested directory", async () => {
    const messages = await lintFixture("singleton-nested-css");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Widget/Widget.ts", messageId: "singletonFolder" },
    ]);
  });

  it("follows require() calls when building the graph", async () => {
    const messages = await lintFixture("require-cjs");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.js", messageId: "privateOutsideOwner" },
    ]);
  });

  it("follows import-equals-require declarations when building the graph", async () => {
    const messages = await lintFixture("require-import-equals");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not count .d.mts declaration files as sources", async () => {
    const messages = await lintFixture("dts-declaration");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report mismatchedEntry for a barrel in the root directory", async () => {
    const messages = await lintFixture("root-barrel", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("rejects unknown options", async () => {
    await expect(
      lintFixture("singleton-flat-ok", { roots: "src" }),
    ).rejects.toThrow();
  });

  it("reports mismatchedEntry when index re-exports one module and outside imports use the barrel", async () => {
    const messages = await lintFixture("mismatch-index");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/index.ts", messageId: "mismatchedEntry" },
    ]);
  });

  it("reports mismatchedEntry when index re-exports one module with a multiline export", async () => {
    const messages = await lintFixture("mismatch-index-multiline");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/index.ts", messageId: "mismatchedEntry" },
    ]);
  });

  it("does not report mismatchedEntry for a namespace barrel with multiple re-exports", async () => {
    const messages = await lintFixture("namespace-barrel-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report mismatchedEntry when outside imports target the named entry file", async () => {
    const messages = await lintFixture("matching-entry-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report mismatchedEntry when nothing outside the directory imports it", async () => {
    const messages = await lintFixture("unused-barrel-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report mismatchedEntry when the index re-exports the named entry file", async () => {
    const messages = await lintFixture("barrel-matching-entry-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports privateOutsideOwner when a private file sits outside its owner folder", async () => {
    const messages = await lintFixture("private-sibling");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report privateOutsideOwner when a private file sits inside its owner folder", async () => {
    const messages = await lintFixture("private-colocated-ok");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports privateOutsideOwner when the single owner is a standalone file", async () => {
    const messages = await lintFixture("private-standalone-owner");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report privateOutsideOwner on a page imported only by a shell", async () => {
    const messages = await lintFixture("page-not-pulled-into-app");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report when an import cycle leaves no importer-free entry", async () => {
    const messages = await lintFixture("cycle-entry");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report when a three-file cycle contains the entry", async () => {
    const messages = await lintFixture("cycle-three");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not treat a file imported by a root and a page as shell", async () => {
    const messages = await lintFixture("mixed-importers", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/shared/fmt.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not let a namespace barrel own what it re-exports", async () => {
    const messages = await lintFixture("barrel-consumer-ok", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("counts an index re-exporting a single sibling as a consumer", async () => {
    const messages = await lintFixture("single-reexport-consumer", {
      root: "src",
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/shared/thing.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not count an ignored consumer when deciding ownership", async () => {
    const messages = await lintFixture("ignore-consumer", {
      root: "src",
      ignore: ["pages/Other/**"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report singletonFolder on the root directory itself", async () => {
    const messages = await lintFixture("root-only-index", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports singletonFolder for a directory holding only an index file", async () => {
    const messages = await lintFixture("singleton-index", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/index.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not count a test file as a directory's second source file", async () => {
    const messages = await lintFixture("singleton-with-test", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not count files in a build directory as a second source file", async () => {
    const messages = await lintFixture("singleton-with-dist", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report when the entry imports itself", async () => {
    const messages = await lintFixture("self-import");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports a page behind a multi-hop bootstrap chain without the shells option", async () => {
    const messages = await lintFixture("shell-chain");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/Home/Home.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report a page behind a multi-hop chain when its directory is a layer", async () => {
    const messages = await lintFixture("shell-chain", {
      layers: ["src/pages"],
    });
    expect(sortMessages(messages)).toEqual([]);
  });

  // The shell reaching past a feature's entry into its internals is a real
  // finding, not noise: boot.ts is shared by App and Cart while living inside
  // Cart. Declaring the shell exempt would hide it, which is why there is no
  // option to do so.
  it("reports a module shared between the app shell and a feature's own tree", async () => {
    const messages = await lintFixture("shell-reaches-internals", {
      root: "src",
      layers: ["features", "pages"],
    });
    expect(sortMessages(messages)).toEqual([
      {
        file: "src/features/Cart/internals/boot.ts",
        messageId: "sharedInsideOwner",
      },
    ]);
  });

  it("reports sharedTooHigh when a shared file sits above the owners' common ancestor", async () => {
    const messages = await lintFixture("shared-too-high");
    expect(sortMessages(messages)).toEqual([
      { file: "src/helpers/fmt.ts", messageId: "sharedTooHigh" },
      { file: "src/pages/A/A.ts", messageId: "singletonFolder" },
      { file: "src/pages/B/B.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report shared placement when the file sits at the owners' common ancestor", async () => {
    const messages = await lintFixture("shared-at-lca-ok");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/A/A.ts", messageId: "singletonFolder" },
      { file: "src/pages/B/B.ts", messageId: "singletonFolder" },
    ]);
  });

  it("reports sharedInsideOwner when a shared file sits inside one owner's folder", async () => {
    const messages = await lintFixture("shared-inside-owner");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/A/fmt.ts", messageId: "sharedInsideOwner" },
      { file: "src/pages/B/B.ts", messageId: "singletonFolder" },
    ]);
  });

  it("reports sharedInsideOwner when a shared file sits inside the innermost nested owner", async () => {
    const messages = await lintFixture("shared-inside-nested-owner");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/Outer/Inner/fmt.ts", messageId: "sharedInsideOwner" },
    ]);
  });

  it("does not report shared placement when the file sits in a common subdirectory", async () => {
    const messages = await lintFixture("shared-common-subdir-ok");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/A/A.ts", messageId: "singletonFolder" },
      { file: "src/pages/B/B.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report a shared file at the LCA inside an ancestor that owns both consumers", async () => {
    const messages = await lintFixture("shared-at-lca-under-owner");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports a folder entry shared out of the owner tree it is buried in", async () => {
    const messages = await lintFixture("shared-entry-inside-owner");
    expect(sortMessages(messages)).toEqual([
      {
        file: "src/pages/A/Widget/Widget.ts",
        messageId: "sharedInsideOwner",
      },
    ]);
  });

  it("reports a folder entry buried in a non-consumer owner and shared by two others", async () => {
    const messages = await lintFixture("shared-entry-inside-other-owner");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/C/Sub/Sub.ts", messageId: "sharedInsideOwner" },
    ]);
  });

  it("does not report sharedInsideOwner when no consumer owns the shared directory", async () => {
    const messages = await lintFixture("shared-standalone-consumer");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports sharedInsideOwner when the shared file sits inside a non-consumer owner", async () => {
    const messages = await lintFixture("shared-inside-other-owner");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/C/parts/fmt.ts", messageId: "sharedInsideOwner" },
    ]);
  });

  it("does not report sharedInsideOwner on an owner folder's own entry file", async () => {
    const messages = await lintFixture("shared-owner-entry");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports mismatchedEntry when one sibling is re-exported as both value and type", async () => {
    const messages = await lintFixture("type-split-barrel");
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/index.ts", messageId: "mismatchedEntry" },
    ]);
  });

  it("does not report privateOutsideOwner on a layer public module with one consumer", async () => {
    const messages = await lintFixture("layer-single-consumer", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report privateOutsideOwner on a standalone layer public module", async () => {
    const messages = await lintFixture("layer-standalone", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report sharedTooHigh on a layer public module whose consumers share a sibling tree", async () => {
    const messages = await lintFixture("layer-shared-sibling-tree", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/A/A.ts", messageId: "singletonFolder" },
      { file: "src/pages/B/B.ts", messageId: "singletonFolder" },
    ]);
  });

  it("reports privateOutsideOwner on a nested private file that is not a layer public module", async () => {
    const messages = await lintFixture("layer-nested-private", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
      { file: "src/ui/Button/icon.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("reports privateOutsideOwner on a sibling helper outside a configured layer", async () => {
    const messages = await lintFixture("non-layer-sibling-helper", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
      { file: "src/pages/widget.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("reports privateOutsideOwner when the private import uses a tsconfig path alias", async () => {
    const messages = await lintFixture("alias-private");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("resolves path aliases declared without baseUrl", async () => {
    const messages = await lintFixture("alias-private-no-baseurl");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "follows a relative import whose case does not match the file on disk",
    async () => {
      const messages = await lintFixture("wrong-case-import");
      expect(sortMessages(messages)).toEqual([
        { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      ]);
    },
  );

  // A link out of the root is not followed: such files cannot be reported (they
  // are outside root) but would still act as owners, which produced phantom
  // second owners and unactionable reports. The consumer inside vendor/ is
  // therefore invisible, and helper.ts is judged on its in-root consumer alone.
  it("does not count consumers behind a symlink out of the root", async () => {
    const messages = await lintFixture("symlinked-module", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report privateOutsideOwner on a layer module whose entry is an index file", async () => {
    const messages = await lintFixture("layer-index-entry", {
      layers: ["src/ui"],
    });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not count ignored files toward the singleton check", async () => {
    const messages = await lintFixture("singleton-ignored", {
      ignore: ["**/*.generated.ts"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("resolves path aliases inherited through tsconfig extends", async () => {
    const messages = await lintFixture("alias-extends");
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report privateOutsideOwner on a helper skipped by ignore globs", async () => {
    const messages = await lintFixture("ignore-glob", {
      ignore: ["**/helper.ts"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report inside a directory excluded by an ignore glob", async () => {
    const messages = await lintFixture("ignored-dir", {
      root: "src",
      ignore: ["gen"],
    });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report inside a build directory under the root", async () => {
    const messages = await lintFixture("skipped-dir", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports inside a directory whose name begins with two dots", async () => {
    const messages = await lintFixture("dotdot-dir", { root: "src" });
    expect(sortMessages(messages)).toEqual([
      { file: "src/..data/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report mismatchedEntry for a barrel that also re-exports foreign modules", async () => {
    const messages = await lintFixture("aggregator-barrel", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report mismatchedEntry for an index that re-exports itself", async () => {
    const messages = await lintFixture("self-reexport-barrel", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("treats a symlinked companion stylesheet as a companion", async () => {
    const messages = await lintFixture("symlinked-style", { root: "src" });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("does not report on a subject file skipped by ignore globs", async () => {
    const messages = await lintFixture("ignore-subject", {
      ignore: ["**/Foo.ts"],
    });
    expect(sortMessages(messages)).toEqual([]);
  });

  it("reports privateOutsideOwner when linting only the helper file", async () => {
    const cwd = path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/private-sibling",
    );
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
          plugins: {
            "file-ownership-lint": plugin,
          },
          rules: {
            "file-ownership-lint/ownership": ["error", {}],
          },
          languageOptions: {
            parser: tsParser,
            parserOptions: {
              sourceType: "module",
              ecmaVersion: 2022,
            },
          },
        },
      ],
    });

    const results = await eslint.lintFiles(["src/pages/helper.ts"]);
    const messages: { file: string; messageId: string }[] = [];

    for (const result of results) {
      for (const message of result.messages) {
        if (
          message.ruleId === "file-ownership-lint/ownership" &&
          message.messageId
        ) {
          messages.push({
            file: path.relative(cwd, result.filePath),
            messageId: message.messageId,
          });
        }
      }
    }

    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });
});
