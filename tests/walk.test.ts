import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraph, getGraph, resolveSpecifier } from "../src/lib/graph.js";

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
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fol-walk-"));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function link(dir: string, target: string, linkPath: string): void {
  fs.symlinkSync(target, path.join(dir, linkPath));
}

function relFiles(dir: string, root: string, ignore: string[] = []): string[] {
  return buildGraph(path.join(dir, root), ignore)
    .files.map((file) => path.relative(dir, file))
    .sort();
}

describe("walking the tree", () => {
  it("keeps files reached through another path when one path is ignored", () => {
    const dir = project({
      "src/zzz/Widget.ts": "export const w = 1;\n",
      "src/pages/helper.ts": "export const h = 1;\n",
    });
    link(dir, "zzz", "src/aaa");

    expect(relFiles(dir, "src", ["aaa/**"])).toEqual([
      "src/pages/helper.ts",
      "src/zzz/Widget.ts",
    ]);
  });

  it("keeps ignoring files reached through a symlink", () => {
    const dir = project({
      "src/zzz/Gen.ts": "export const g = 1;\n",
      "src/pages/helper.ts": "export const h = 1;\n",
    });
    fs.mkdirSync(path.join(dir, "src/aaa"), { recursive: true });
    link(dir, "../zzz", "src/aaa/link");

    expect(relFiles(dir, "src", ["zzz/**"])).toEqual(["src/pages/helper.ts"]);
  });

  it("does not follow a symlink that points at an ancestor of the root", () => {
    const dir = project({
      "src/pages/helper.ts": "export const h = 1;\n",
      "legacy/Old.ts": 'import "../src/pages/helper";\nexport const o = 1;\n',
    });
    link(dir, "..", "src/up");

    expect(relFiles(dir, "src")).toEqual(["src/pages/helper.ts"]);
  });

  it("follows a symlinked directory pointing outside the root", () => {
    const dir = project({
      "src/pages/helper.ts": "export const h = 1;\n",
      "vendor/Consumer.ts": 'import "../src/pages/helper";\nexport const c = 1;\n',
    });
    link(dir, "../../vendor", "src/pages/linked");

    expect(relFiles(dir, "src")).toEqual([
      "src/pages/helper.ts",
      "vendor/Consumer.ts",
    ]);
  });

  it("does not record a file as importing itself through a wrong-case specifier", () => {
    const dir = project({
      "src/pages/helper.ts": 'import "./Helper";\nexport const h = 1;\n',
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.size).toBe(0);
  });
});

describe("resolution fallbacks", () => {
  it("resolves an aliased import onto extensions the compiler declines", () => {
    const dir = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
      }),
      "src/pages/helper.cts": "export const h = 1;\n",
      "src/pages/MyPage/MyPage.ts": 'import "@/pages/helper";\nexport const p = 1;\n',
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(
      graph.importers.get(path.join(dir, "src/pages/helper.cts")),
    ).toEqual([path.join(dir, "src/pages/MyPage/MyPage.ts")]);
  });

  it("still resolves relative imports onto those extensions", () => {
    const dir = project({
      "src/a.ts": 'import "./b";\n',
      "src/b.cts": "export const b = 1;\n",
    });

    expect(resolveSpecifier("./b", path.join(dir, "src"))).toBe(
      path.join(dir, "src/b.cts"),
    );
  });
});

describe("caching with a symlinked root", () => {
  it("reuses the cached graph when a symlinked path is ignored", () => {
    const dir = project({
      "src/zzz/Widget.ts": "export const w = 1;\n",
      "src/pages/helper.ts": "export const h = 1;\n",
    });
    link(dir, "zzz", "src/aaa");

    const root = path.join(dir, "src");
    const current = path.join(dir, "src/zzz/Widget.ts");

    const first = getGraph(root, ["aaa/**"], current);
    expect(getGraph(root, ["aaa/**"], current)).toBe(first);
  });

  it("reuses the cached graph when the root is reached through a symlink", () => {
    const dir = project({
      "real/tsconfig.json": JSON.stringify({ compilerOptions: {} }),
      "real/src/a.ts": 'import "./b";\n',
      "real/src/b.ts": "export const b = 1;\n",
    });
    link(dir, "real", "linked");

    const root = path.join(dir, "linked/src");
    const current = path.join(dir, "real/src/a.ts");

    const first = getGraph(root, [], current);
    expect(getGraph(root, [], current)).toBe(first);
  });
});
