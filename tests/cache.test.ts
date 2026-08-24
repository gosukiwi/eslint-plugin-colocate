import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  // up with both rules on. Measured on this fixture shape: 20 files fixed is
  // ~420 statSync calls (linear, ~21/file); the O(files^2) version was ~820
  // (~41/file) and grows relative to file count, so the bound below sits
  // between the two rather than pinning an exact figure that would be brittle
  // to unrelated stat-count changes elsewhere in the walk.
  it("does not re-validate the whole tracked set once per rule when several rules share a lint pass", async () => {
    const fileCount = 20;
    const files: Record<string, string> = {};
    for (let i = 0; i < fileCount; i += 1) {
      files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
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
      expect(statSpy.mock.calls.length).toBeLessThan(fileCount * 25);
    } finally {
      statSpy.mockRestore();
    }
  });

  // The fix for the above (a visitToken carried on the cache entry) must not
  // regress the case it looks structurally identical to: a genuinely new pass
  // that happens to start on the very file the previous pass ended on -
  // exactly what a watch-mode re-lint of a single open file does. Each
  // separate lintFiles() call gets its own ESLint SourceCode object even for
  // an unchanged file, so the token differs across passes and this still
  // revalidates.
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
});
