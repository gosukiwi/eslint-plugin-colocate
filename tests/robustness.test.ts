import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMessages,
  lintFixture,
  makeESLint,
} from "./helpers/lint-fixture.js";

function sortMessages(
  messages: { file: string; messageId: string }[],
): { file: string; messageId: string }[] {
  return [...messages].sort((a, b) => {
    const fileOrder = a.file.localeCompare(b.file);
    return fileOrder !== 0 ? fileOrder : a.messageId.localeCompare(b.messageId);
  });
}

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fol-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("robustness", () => {
  it("stays silent instead of throwing when the configured root is missing", async () => {
    const messages = await lintFixture("missing-root", { root: "src" }, ["lib"]);
    expect(messages).toEqual([]);
  });

  it("stays silent instead of throwing when the linted file is not on disk", async () => {
    const cwd = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "fixtures/private-sibling",
    );
    const results = await makeESLint(cwd).lintText("export const ghost = 1;\n", {
      filePath: path.join(cwd, "src/pages/ghost.ts"),
    });
    expect(collectMessages(cwd, results)).toEqual([]);
  });

  it("does not throw when a cached importer was deleted from disk", async () => {
    const dir = tempProject({
      "src/main.ts": 'import "./App";\n',
      "src/App.ts": 'import "./pages/MyPage";\n',
      "src/pages/helper.ts": "export const h = 1;\n",
      "src/pages/MyPage/index.ts":
        'import "../helper";\nexport * from "./MyPage";\n',
      "src/pages/MyPage/MyPage.ts": "export const p = 1;\n",
    });
    try {
      const eslint = makeESLint(dir, { root: "src" });
      await eslint.lintFiles(["src"]);
      fs.rmSync(path.join(dir, "src/pages/MyPage/index.ts"));

      const results = await makeESLint(dir, { root: "src" }).lintFiles([
        "src/pages/helper.ts",
      ]);
      expect(() => collectMessages(dir, results)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent instead of throwing when a source file is unreadable", async () => {
    const dir = tempProject({
      "src/main.ts": 'import "./App";\n',
      "src/App.ts": "export const a = 1;\n",
    });
    const secret = path.join(dir, "src/App.ts");
    try {
      fs.chmodSync(secret, 0o000);
      const results = await makeESLint(dir, { root: "src" }).lintFiles([
        "src/main.ts",
      ]);
      expect(() => collectMessages(dir, results)).not.toThrow();
    } finally {
      fs.chmodSync(secret, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report on files outside the configured root", async () => {
    const messages = await lintFixture("outside-root", { root: "src" }, [
      "src",
      "tools",
    ]);
    expect(sortMessages(messages)).toEqual([
      { file: "src/Feature/Feature.ts", messageId: "singletonFolder" },
    ]);
  });

  it("defaults root to the working directory", async () => {
    const messages = await lintFixture("root-drop", {}, ["."]);
    expect(sortMessages(messages)).toEqual([
      { file: "Foo/Foo.ts", messageId: "singletonFolder" },
    ]);
  });
});
