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

  // ownership and entry both call getGraph for the same file within one lint
  // pass. getGraph's pass-boundary check used to key only on the linted file
  // path, so this second call looked exactly like a new pass landing on the
  // same file and re-validated every tracked file by stat'ing it - once per
  // linted file, per lint pass, an O(files^2) statSync cost that only showed
  // up with both rules on. Every file has an import statement so entry's lazy
  // getGraph call (made as soon as there is a specifier to check, whether or
  // not it resolves) fires for each file - an import-free fixture would
  // exercise only ownership's Program-level call and miss the bug entirely.
  // The imported specifier does not resolve to anything in the fixture, so it
  // creates no graph edge and triggers no ownership finding, keeping this
  // test focused on getGraph call counting rather than ownership's placement
  // rules. Asserted as a growth-rate comparison rather than a fixed
  // threshold: a handful of unrelated extra stats anywhere in the walk would
  // make a tight fixed bound flaky, but linear-in-files growth (this fix) and
  // quadratic growth (the regression) are far enough apart that doubling the
  // file count and checking the call count did not also roughly double keeps
  // the test meaningful without pinning an exact figure.
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

    // Linear growth roughly doubles the call count when the file count
    // doubles; the O(files^2) regression roughly quadruples it. The bound
    // sits well above the former and well below the latter.
    expect(large).toBeLessThan(small * 2.5);
  });

  // The fix for the above (a visitToken carried on the cache entry) must not
  // regress the case it looks structurally identical to: a genuinely new pass
  // that happens to start on the very file the previous pass ended on -
  // exactly what a watch-mode re-lint of a single open file does. Each
  // separate lintFiles() call gets its own ESLint SourceCode object even for
  // an unchanged file, so the token differs across passes and this still
  // revalidates.
  //
  // Both this test and the one above depend on their lintFiles() calls
  // landing within REVALIDATE_AFTER_MS (100ms) of each other - the case they
  // exercise (same file, different token) only fails the "same visit" check
  // on the token; if the elapsed-time bound also tripped, revalidation would
  // still happen, just for the wrong reason. On a sufficiently slow machine
  // this test would still pass, but via the timer rather than the token it
  // is meant to prove, losing its specificity.
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

  // Token identity proves "same SourceCode object", not "same moment". A host
  // may hold one SourceCode and verify it repeatedly - Linter#verify accepts a
  // SourceCode instance and hands its identity straight through to
  // context.sourceCode - and an unbounded short-circuit turned that into a
  // permanently frozen graph: every later verify matched the token, so neither
  // the tsconfig check nor the tracked-file sweep ever ran again and the report
  // could not be cleared by editing any file other than the linted one. Uses
  // Linter rather than the ESLint class because only Linter lets a caller supply
  // the SourceCode and thus pin the token across passes.
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
    // Past REVALIDATE_AFTER_MS, so a correctly bounded short-circuit must let
    // the tracked-file sweep run even though file and token both still match.
    // Sleeps against the real constant rather than a copy of its value, so
    // raising it cannot turn this into a mystery failure here.
    await new Promise((resolve) =>
      setTimeout(resolve, REVALIDATE_AFTER_MS + 50),
    );

    expect(ids(linter.verify(retained, config, helper))).toEqual([]);
  });
});
