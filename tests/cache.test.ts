import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVALIDATE_AFTER_MS } from "../src/lib/graph-cache.js";
import plugin from "../src/index.js";
import { collectMessages, makeESLint } from "./helpers/lint-fixture.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fol-"));
  created.push(dir);
  write(dir, files);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

async function lint(
  dir: string,
  targets: string[],
  options: Record<string, unknown> = { root: "src" },
): Promise<{ file: string; messageId: string }[]> {
  const results = await makeESLint(dir, options).lintFiles(targets);
  return collectMessages(dir, results);
}

const APP = {
  "src/main.ts": 'import "./App";\n',
  "src/App.ts": 'import "./pages/MyPage/MyPage";\n',
  "src/pages/helper.ts": "export const h = 1;\n",
  "src/pages/MyPage/MyPage.ts": "export const p = 1;\n",
  "src/pages/MyPage/MyPage.module.css": ".page {}\n",
};

describe("graph invalidation within one process", () => {
  it("picks up an import added to a different file", async () => {
    const dir = project(APP);
    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([]);

    write(dir, {
      "src/pages/MyPage/MyPage.ts": 'import "../helper";\nexport const p = 1;\n',
    });

    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("clears the report when the offending import is removed from a different file", async () => {
    const dir = project({
      ...APP,
      "src/pages/MyPage/MyPage.ts": 'import "../helper";\nexport const p = 1;\n',
    });
    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);

    write(dir, { "src/pages/MyPage/MyPage.ts": "export const p = 1;\n" });

    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([]);
  });

  it("clears the report when the only importer is deleted", async () => {
    const dir = project({
      ...APP,
      "src/pages/MyPage/MyPage.ts": 'import "../helper";\nexport const p = 1;\n',
    });
    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);

    fs.rmSync(path.join(dir, "src/pages/MyPage"), { recursive: true });

    expect(await lint(dir, ["src/pages/helper.ts"])).toEqual([]);
  });

  it("picks up a layer directory created after the first lint", async () => {
    const dir = project(APP);
    const options = { root: "src", layers: ["src/ui"] };
    expect(await lint(dir, ["src"], options)).toEqual([]);

    write(dir, {
      "src/ui/Modal.ts": "export const m = 1;\n",
      "src/pages/MyPage/MyPage.ts": 'import "../../ui/Modal";\nexport const p = 1;\n',
    });

    expect(await lint(dir, ["src"], options)).toEqual([]);
  });

  async function countStatsForFileCount(fileCount: number): Promise<number> {
    const files: Record<string, string> = {};
    for (let i = 0; i < fileCount; i += 1) {
      files[`src/file${i}.ts`] =
        `import "./does-not-exist.js";\nexport const v${i} = ${i};\n`;
    }
    const dir = project(files);

    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const results = await makeESLint(
        dir,
        { root: "src" },
        { rule: ["ownership", "entry"] },
      ).lintFiles(["src"]);
      expect(collectMessages(dir, results)).toEqual([]);
      return statSpy.mock.calls.length;
    } finally {
      statSpy.mockRestore();
    }
  }

  it("does not re-validate the whole tracked set once per rule when several rules share a lint pass", async () => {
    const small = await countStatsForFileCount(20);
    const large = await countStatsForFileCount(40);

    expect(large).toBeLessThan(small * 2.5);
  });

  it("still revalidates when a new pass starts on the same single file the previous pass ended on", async () => {
    const dir = project(APP);
    const options = { root: "src" };
    const rules = { rule: ["ownership", "entry"] as const };

    const first = await makeESLint(dir, options, rules).lintFiles([
      "src/pages/helper.ts",
    ]);
    expect(collectMessages(dir, first)).toEqual([]);

    write(dir, {
      "src/pages/MyPage/MyPage.ts":
        'import "../helper";\nexport const p = 1;\n',
    });

    const second = await makeESLint(dir, options, rules).lintFiles([
      "src/pages/helper.ts",
    ]);
    expect(collectMessages(dir, second)).toEqual([
      { file: "src/pages/helper.ts", messageId: "privateOutsideOwner" },
    ]);
  });

  it("revalidates when one retained SourceCode is verified again after an edit", async () => {
    const dir = project({
      ...APP,
      "src/pages/MyPage/MyPage.ts": 'import "../helper";\nexport const p = 1;\n',
    });
    const helper = path.join(dir, "src/pages/helper.ts");
    const linter = new Linter({ cwd: dir });
    const config = {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tsParser,
        parserOptions: { sourceType: "module", ecmaVersion: 2022 },
      },
      plugins: { colocate: plugin },
      rules: { "colocate/ownership": ["error", { root: "src" }] },
    } as unknown as Linter.Config;

    const ids = (messages: Linter.LintMessage[]): (string | undefined)[] =>
      messages.map((message) => message.messageId);

    expect(
      ids(linter.verify(fs.readFileSync(helper, "utf8"), config, helper)),
    ).toEqual(["privateOutsideOwner"]);

    const retained = linter.getSourceCode();
    write(dir, { "src/pages/MyPage/MyPage.ts": "export const p = 1;\n" });
    await new Promise((resolve) =>
      setTimeout(resolve, REVALIDATE_AFTER_MS + 50),
    );

    expect(ids(linter.verify(retained, config, helper))).toEqual([]);
  });
});
