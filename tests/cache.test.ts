import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGraph, REVALIDATE_AFTER_MS } from "../src/lib/graph-cache.js";
import plugin from "../src/index.js";
import {
  collectMessages,
  collectRuleMessages,
  makeESLint,
} from "./helpers/lint-fixture.js";

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

  it("revalidates a different file after a 100 ms gap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
    try {
      const dir = project({
        "src/a.ts": "export const a = 1;\n",
        "src/b.ts": "export const b = 1;\n",
      });
      const root = path.join(dir, "src");
      const aPath = path.join(dir, "src/a.ts");
      const bPath = path.join(dir, "src/b.ts");

      const first = getGraph(root, [], aPath, {});
      fs.writeFileSync(bPath, 'import "./a";\nexport const b = 1;\n');
      vi.advanceTimersByTime(REVALIDATE_AFTER_MS + 50);
      const second = getGraph(root, [], bPath, {});
      expect(second).not.toBe(first);
      expect(second.importers.get(aPath)).toEqual([bPath]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-stat tracked files every 100 ms during one pass", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00Z"));
    let statSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const files: Record<string, string> = {};
      for (let i = 0; i < 10; i += 1) {
        files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
      }
      const dir = project(files);
      const root = path.join(dir, "src");
      const paths = Array.from({ length: 10 }, (_, i) =>
        path.join(dir, `src/file${i}.ts`),
      );

      const firstToken = {};
      getGraph(root, [], paths[0], firstToken);
      getGraph(root, [], paths[0], firstToken);

      statSpy = vi.spyOn(fs, "statSync");
      for (let i = 1; i < paths.length; i += 1) {
        vi.advanceTimersByTime(50);
        const token = {};
        getGraph(root, [], paths[i], token);
        getGraph(root, [], paths[i], token);
      }

      const tracked = new Set(paths);
      const trackedStats = statSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && tracked.has(call[0]),
      ).length;
      expect(trackedStats).toBe(0);
    } finally {
      statSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

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

  it("reports reachesPastEntry on an already-linted importer after a door file is created", async () => {
    const dir = project({
      "src/app.ts": 'import "./Feature/state";\n',
      "src/Feature/state.ts": "export const s = 1;\n",
    });
    const options = { root: "src" };
    const eslint = makeESLint(dir, options, { rule: "entry" });

    const first = await eslint.lintFiles(["src/app.ts"]);
    expect(collectRuleMessages(dir, first, "entry")).toEqual([]);

    write(dir, { "src/Feature/index.ts": "export const door = 1;\n" });

    const second = await eslint.lintFiles(["src/app.ts"]);
    expect(
      collectRuleMessages(dir, second, "entry").map(({ file, messageId }) => ({
        file,
        messageId,
      })),
    ).toEqual([{ file: "src/app.ts", messageId: "reachesPastEntry" }]);
  });

  it("treats a named door that is a file symlink as a door", async () => {
    const dir = project({
      "src/app.ts": 'import "./Feature/util";\n',
      "src/Feature/util.ts": "export const u = 1;\n",
      "src/shared/impl.ts": "export const i = 1;\n",
    });
    fs.symlinkSync(
      path.join(dir, "src/shared/impl.ts"),
      path.join(dir, "src/Feature/Feature.ts"),
    );

    const results = await makeESLint(
      dir,
      { root: "src" },
      { rule: ["ownership", "entry"] },
    ).lintFiles(["src"]);

    expect(
      collectRuleMessages(dir, results, "ownership").map(({ file, messageId }) => ({
        file,
        messageId,
      })),
    ).not.toContainEqual({
      file: "src/Feature/util.ts",
      messageId: "privateOutsideOwner",
    });
    expect(
      collectRuleMessages(dir, results, "entry").map(({ file, messageId }) => ({
        file,
        messageId,
      })),
    ).toEqual([{ file: "src/app.ts", messageId: "reachesPastEntry" }]);
  });

  it("rebuilds after a file symlink inside root is retargeted", async () => {
    const dir = project({
      "src/main.ts": 'import "./App";\n',
      "src/App.ts": 'import "./B/B";\n',
      "src/B/B.ts": 'import "./target";\nexport const b = 1;\n',
      "src/fmt.ts": "export const f = 1;\n",
      "src/other.ts": "export const o = 1;\n",
    });
    fs.symlinkSync("../fmt.ts", path.join(dir, "src/B/target.ts"));

    const first = await lint(dir, ["src"]);
    expect(first).toContainEqual({
      file: "src/fmt.ts",
      messageId: "privateOutsideOwner",
    });
    expect(first).toContainEqual({
      file: "src/B/target.ts",
      messageId: "privateOutsideOwner",
    });

    fs.unlinkSync(path.join(dir, "src/B/target.ts"));
    fs.symlinkSync("../other.ts", path.join(dir, "src/B/target.ts"));
    await new Promise((resolve) =>
      setTimeout(resolve, REVALIDATE_AFTER_MS + 50),
    );

    const second = await lint(dir, ["src"]);
    expect(second).toContainEqual({
      file: "src/other.ts",
      messageId: "privateOutsideOwner",
    });
    expect(second).toContainEqual({
      file: "src/B/target.ts",
      messageId: "privateOutsideOwner",
    });
    expect(second.filter((message) => message.file === "src/fmt.ts")).toEqual(
      [],
    );
  });

  it("drops the previous graph when root or ignore changes", () => {
    const dir = project({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    const root = path.join(dir, "src");
    const file = path.join(dir, "src/a.ts");

    const first = getGraph(root, [], file);
    getGraph(root, ["no-such-dir"], file);
    const again = getGraph(root, [], file);
    expect(again).not.toBe(first);
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
