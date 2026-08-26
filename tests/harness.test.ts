import { describe, expect, it } from "vitest";
import { lintFixture, lintFixtureRule } from "./helpers/lint-fixture.js";

describe("fixture harness", () => {
  it("keeps the two-key shape the ownership assertions were written against", async () => {
    const messages = await lintFixture("singleton-flag");
    expect(messages).toEqual([
      { file: "src/Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });

  // Entry reports are per-import, so several land in one file and assertions
  // need to tell them apart.
  it("exposes line and message when a rule is named explicitly", async () => {
    const messages = await lintFixtureRule("singleton-flag", "ownership");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      file: "src/Foo/Foo.ts",
      messageId: "singletonFolder",
    });
    expect(messages[0].line).toBeGreaterThan(0);
    expect(messages[0].message).toContain("colocate");
  });
});
