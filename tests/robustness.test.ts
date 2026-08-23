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

  it("finds a relative root when invoked from a subdirectory", async () => {
    const fixture = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "fixtures/private-sibling",
    );
    const results = await makeESLint(path.join(fixture, "src/pages"), {
      root: "src",
    }).lintFiles(["helper.ts"]);

    expect(collectMessages(fixture, results)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("does not resolve a relative root past a project boundary", async () => {
    const outer = tempProject({
      "src/unrelated/lib.ts": "export const u = 1;\n",
      "src/repo/package.json": "{}\n",
      "src/repo/app/main.ts": 'import "./App";\n',
      "src/repo/app/App.ts": 'import "./MyPage/MyPage";\n',
      "src/repo/app/helper.ts": "export const h = 1;\n",
      "src/repo/app/MyPage/MyPage.ts": 'import "../helper";\nexport const p = 1;\n',
    });
    const cwd = path.join(outer, "src/repo");
    try {
      const results = await makeESLint(cwd, { root: "src" }).lintFiles(["app"]);
      expect(collectMessages(cwd, results)).toEqual([]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("is not disabled by a __tests__ directory above the root", async () => {
    const outer = tempProject({
      "__tests__/repo/src/main.ts": 'import "./App";\n',
      "__tests__/repo/src/App.ts": 'import "./pages/MyPage/MyPage";\n',
      "__tests__/repo/src/pages/helper.ts": "export const h = 1;\n",
      "__tests__/repo/src/pages/MyPage/MyPage.ts":
        'import "../helper";\nexport const p = 1;\n',
      "__tests__/repo/src/pages/MyPage/MyPage.module.css": ".p {}\n",
    });
    const cwd = path.join(outer, "__tests__/repo");
    try {
      const results = await makeESLint(cwd, { root: "src" }).lintFiles(["src"]);
      expect(collectMessages(cwd, results)).toEqual([
        { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
      ]);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it("counts sources behind a symlinked subdirectory", async () => {
    const dir = tempProject({
      "src/app.ts": 'import "./Foo/Foo";\n',
      "src/Foo/Foo.ts": "export const f = 1;\n",
      "src/realsub/a.ts": "export const a = 1;\n",
      "src/realsub/b.ts": "export const b = 1;\n",
    });
    fs.symlinkSync("../realsub", path.join(dir, "src/Foo/sub"));
    try {
      const results = await makeESLint(dir, { root: "src" }).lintFiles(["src"]);
      expect(
        collectMessages(dir, results).filter(
          (m) => m.messageId === "singletonFolder",
        ),
      ).toEqual([]);
    } finally {
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
