import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGraph, stampIsAmbiguous } from "../src/lib/graph-cache.js";
import { buildGraph } from "../src/lib/graph.js";
import { resolveSpecifier } from "../src/lib/resolve.js";

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

  it("does not record files whose real path escapes the root", () => {
    const dir = project({
      "src/pages/helper.ts": "export const h = 1;\n",
      "vendor/Consumer.ts": 'import "../src/pages/helper";\nexport const c = 1;\n',
    });
    link(dir, "../../vendor", "src/pages/linked");

    expect(relFiles(dir, "src")).toEqual(["src/pages/helper.ts"]);
  });

  it("does not let a symlinked entry file escape the root either", () => {
    const dir = project({
      "src/W/inner.ts": "export const i = 1;\n",
      "elsewhere/W.ts": 'import "../src/W/inner";\nexport const w = 1;\n',
    });
    link(dir, "../../elsewhere/W.ts", "src/W/W.ts");

    expect(relFiles(dir, "src")).toEqual(["src/W/inner.ts"]);
  });

  it("keeps excluding a build directory reached through a symlink", () => {
    const dir = project({
      "src/main.ts": "export const m = 1;\n",
      "src/dist/Deep/bundle.ts": "export const b = 1;\n",
    });
    link(dir, "dist", "src/link");

    expect(relFiles(dir, "src")).toEqual(["src/main.ts"]);
  });

  it("keeps excluding an ignored directory reached below its own name", () => {
    const dir = project({
      "src/main.ts": "export const m = 1;\n",
      "src/gen/Other/x.ts": "export const x = 1;\n",
    });
    link(dir, "gen/Other", "src/link");

    expect(relFiles(dir, "src", ["gen"])).toEqual(["src/main.ts"]);
  });

  it("does not blow up on nested sibling symlinks", () => {
    const files: Record<string, string> = { "src/leaf/real.ts": "export const r = 1;\n" };
    for (let i = 0; i < 12; i += 1) files[`src/d${i}/keep.ts`] = "export const k = 1;\n";
    const dir = project(files);
    for (let i = 0; i < 11; i += 1) {
      link(dir, `../d${i + 1}`, `src/d${i}/p`);
      link(dir, `../d${i + 1}`, `src/d${i}/q`);
    }

    const started = Date.now();
    const graph = buildGraph(path.join(dir, "src"), []);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(graph.files.length).toBe(13);
  });

  it("does not record a file as importing itself through a wrong-case specifier", () => {
    const dir = project({
      "src/pages/helper.ts": 'import "./Helper";\nexport const h = 1;\n',
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.size).toBe(0);
  });
});

describe("specifier extraction", () => {
  it("follows a real require() call", () => {
    const dir = project({
      "src/A/A.ts": 'const h = require("../help");\nexport const a = h;\n',
      "src/help.ts": "export const h = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/help.ts"))).toEqual([
      path.join(dir, "src/A/A.ts"),
    ]);
  });

  it("ignores a require call bound to a local function", () => {
    const dir = project({
      "src/A/A.ts":
        'function require(_s: string): unknown {\n  return null;\n}\nexport const a = require("../help");\n',
      "src/help.ts": "export const h = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/help.ts"))).toBeUndefined();
  });

  it("follows require() when an unrelated block binds the name later", () => {
    const dir = project({
      "src/A/A.ts":
        'const h = require("../help");\nif (h) {\n  const require = 1;\n  console.log(require);\n}\nexport const a = h;\n',
      "src/help.ts": "export const h = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/help.ts"))).toEqual([
      path.join(dir, "src/A/A.ts"),
    ]);
  });

  it("follows require() created by createRequire", () => {
    const dir = project({
      "src/A/A.ts":
        'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport const a = require("../help");\n',
      "src/help.ts": "export const h = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/help.ts"))).toEqual([
      path.join(dir, "src/A/A.ts"),
    ]);
  });

  it("ignores a require call bound to a parameter", () => {
    const dir = project({
      "src/A/A.ts":
        'export function A(require: (s: string) => unknown): unknown {\n  return require("../help");\n}\n',
      "src/help.ts": "export const h = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/help.ts"))).toBeUndefined();
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

  it("resolves a directory import onto an index file the compiler declines", () => {
    const dir = project({
      "src/app.ts": 'import "./Foo";\n',
      "src/Foo/index.cts": "export const i = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/Foo/index.cts"))).toEqual([
      path.join(dir, "src/app.ts"),
    ]);
  });

  it("does not fall through to a shorter path alias the compiler would not use", () => {
    const dir = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@app/*": ["./src/*"], "@app/legacy/*": ["./legacy/*"] },
        },
      }),
      "src/main.ts": 'import "@app/legacy/x";\n',
      "src/legacy/x.ts": "export const x = 1;\n",
    });
    const graph = buildGraph(path.join(dir, "src"), []);

    expect(graph.importers.get(path.join(dir, "src/legacy/x.ts"))).toBeUndefined();
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

  it("rebuilds when a file changes size but keeps its timestamp", () => {
    const dir = project({
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": "export const b = 1;\n",
    });
    const root = path.join(dir, "src");
    const current = path.join(dir, "src/a.ts");
    const other = path.join(dir, "src/b.ts");

    // Pinned to an exact whole-second timestamp both times, so mtime is
    // genuinely unchanged and only the size differs.
    const pinned = 1_000_000;
    fs.utimesSync(other, pinned, pinned);
    const first = getGraph(root, [], current);

    fs.writeFileSync(other, "export const b = 222222222;\n");
    fs.utimesSync(other, pinned, pinned);

    expect(getGraph(root, [], current)).not.toBe(first);
  });

  it("rebuilds when a same-size edit preserves the timestamp", () => {
    const dir = project({
      "src/a.ts": 'import "./x";\n',
      "src/x.ts": "export const x = 1;\n",
      "src/y.ts": "export const y = 1;\n",
    });
    const root = path.join(dir, "src");
    const edited = path.join(dir, "src/a.ts");
    const pinned = 1_000_000;
    fs.utimesSync(edited, pinned, pinned);

    const first = getGraph(root, [], edited);
    expect(first.importers.get(path.join(dir, "src/x.ts"))).toEqual([edited]);

    // Same byte length, same mtime: only ctime moves, and userland cannot set it.
    fs.writeFileSync(edited, 'import "./y";\n');
    fs.utimesSync(edited, pinned, pinned);

    const second = getGraph(root, [], edited);
    expect(second).not.toBe(first);
    expect(second.importers.get(path.join(dir, "src/y.ts"))).toEqual([edited]);
  });

  it("rebuilds when a config reached through extends changes", () => {
    const dir = project({
      "tsconfig.base.json": JSON.stringify({ compilerOptions: {} }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": "export const b = 1;\n",
    });
    const root = path.join(dir, "src");
    const current = path.join(dir, "src/a.ts");

    const first = getGraph(root, [], current);
    const later = new Date(Date.now() + 4000);
    fs.utimesSync(path.join(dir, "tsconfig.base.json"), later, later);

    expect(getGraph(root, [], current)).not.toBe(first);
  });

  it("reuses the cached graph when linting a file the walk skipped", () => {
    const dir = project({
      "src/main.ts": "export const m = 1;\n",
      "src/gen/Foo.ts": "export const f = 1;\n",
      "src/dist/bundle.ts": "export const b = 1;\n",
    });
    const root = path.join(dir, "src");

    const first = getGraph(root, ["gen"], path.join(dir, "src/main.ts"));
    expect(getGraph(root, ["gen"], path.join(dir, "src/gen/Foo.ts"))).toBe(first);
    expect(getGraph(root, ["gen"], path.join(dir, "src/dist/bundle.ts"))).toBe(
      first,
    );
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
