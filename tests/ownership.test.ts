import { describe, expect, it } from "vitest";
import { lintFixture } from "./helpers/lint-fixture.js";

describe("ownership rule", () => {
  it("reports singletonFolder when a directory has one source file and no CSS", async () => {
    const messages = await lintFixture("singleton-flag");
    expect(messages).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  it("does not report singletonFolder when a CSS file is present", async () => {
    const messages = await lintFixture("singleton-css-ok");
    expect(messages).toEqual([]);
  });

  it("does not report singletonFolder for a standalone flat source file", async () => {
    const messages = await lintFixture("singleton-flat-ok");
    expect(messages).toEqual([]);
  });

  it("reports mismatchedEntry when index re-exports one module and outside imports use the barrel", async () => {
    const messages = await lintFixture("mismatch-index");
    expect(messages).toEqual([
      { file: "src/Foo/index.ts", messageId: "mismatchedEntry" },
    ]);
  });

  it("does not report mismatchedEntry for a namespace barrel with multiple re-exports", async () => {
    const messages = await lintFixture("namespace-barrel-ok");
    expect(messages).toEqual([]);
  });

  it("does not report mismatchedEntry when outside imports target the named entry file", async () => {
    const messages = await lintFixture("matching-entry-ok");
    expect(messages).toEqual([]);
  });

  it("reports privateOutsideOwner when a private file sits outside its owner folder", async () => {
    const messages = await lintFixture("private-sibling");
    expect(
      messages.filter((m) => m.messageId === "privateOutsideOwner"),
    ).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report privateOutsideOwner when a private file sits inside its owner folder", async () => {
    const messages = await lintFixture("private-colocated-ok");
    expect(
      messages.filter((m) => m.messageId === "privateOutsideOwner"),
    ).toEqual([]);
  });

  it("reports privateOutsideOwner when the single owner is a standalone file", async () => {
    const messages = await lintFixture("private-standalone-owner");
    expect(
      messages.filter((m) => m.messageId === "privateOutsideOwner"),
    ).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not report privateOutsideOwner on a page imported only by a shell", async () => {
    const messages = await lintFixture("page-not-pulled-into-app");
    expect(
      messages.filter((m) => m.messageId === "privateOutsideOwner"),
    ).toEqual([]);
  });

  it("reports sharedTooHigh when a shared file sits above the owners' common ancestor", async () => {
    const messages = await lintFixture("shared-too-high");
    expect(
      messages.filter((m) => m.messageId === "sharedTooHigh"),
    ).toEqual([{ file: "src/helpers/fmt.ts", messageId: "sharedTooHigh" }]);
  });

  it("does not report shared placement when the file sits at the owners' common ancestor", async () => {
    const messages = await lintFixture("shared-at-lca-ok");
    expect(
      messages.filter(
        (m) =>
          m.messageId === "sharedTooHigh" ||
          m.messageId === "sharedInsideOwner",
      ),
    ).toEqual([]);
  });

  it("reports sharedInsideOwner when a shared file sits inside one owner's folder", async () => {
    const messages = await lintFixture("shared-inside-owner");
    expect(
      messages.filter((m) => m.messageId === "sharedInsideOwner"),
    ).toEqual([{ file: "src/pages/A/fmt.ts", messageId: "sharedInsideOwner" }]);
  });

  it("does not report shared placement when the file sits in a common subdirectory", async () => {
    const messages = await lintFixture("shared-common-subdir-ok");
    expect(
      messages.filter(
        (m) =>
          m.messageId === "sharedTooHigh" ||
          m.messageId === "sharedInsideOwner",
      ),
    ).toEqual([]);
  });
});
