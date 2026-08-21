import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
