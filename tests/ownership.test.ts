import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
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

  it("honors a file-level eslint-disable comment", async () => {
    const messages = await lintFixture("eslint-disable-ownership");
    expect(sortMessages(messages)).toEqual([]);
  });

  it("honors a file-level eslint-disable comment with Espree on ESLint 10", async () => {
    const messages = await lintFixture(
      "eslint-disable-ownership-js",
      {},
      { parser: "espree" },
    );
    expect(sortMessages(messages)).toEqual([]);
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

  it("does not report privateOutsideOwner on a helper skipped by ignore globs", async () => {
    const messages = await lintFixture("ignore-glob", {
      ignore: ["**/helper.ts"],
    });
    expect(sortMessages(messages)).toEqual([
      { file: "src/pages/MyPage/MyPage.ts", messageId: "singletonFolder" },
    ]);
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
