import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraph, type Graph } from "../src/lib/graph.js";
import {
  collectLayerDirectories,
  collectReExports,
  resolveLayerDirectories,
} from "../src/lib/owners.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function foldsNormalization(dir: string): boolean {
  const name = "probe-Café.ts";
  fs.writeFileSync(path.join(dir, name.normalize("NFD")), "");
  return fs.existsSync(path.join(dir, name.normalize("NFC")));
}

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/layer-standalone",
);

const nestedLayerRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/layer-single-consumer",
);

function emptyGraph(): Graph {
  return { importers: new Map(), files: [] };
}

describe("collectLayerDirectories", () => {
  it("expands single-segment * globs to child directories", () => {
    const cwd = fs.realpathSync(nestedLayerRoot);
    const buttonDir = path.join(cwd, "src/ui/Button");

    expect(collectLayerDirectories(cwd, ["src/ui/*"])).toEqual([buttonDir]);
  });

  it("resolves ** globs by walking from cwd", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");

    expect(collectLayerDirectories(cwd, ["**/ui"])).toEqual([uiDir]);
  });

  it("returns nothing when no globs are configured", () => {
    expect(collectLayerDirectories(fs.realpathSync(fixtureRoot), [])).toEqual([]);
  });
});

describe("resolveLayerDirectories", () => {
  it("memoises per graph, cwd and globs", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");
    const graph = emptyGraph();

    const dirs = resolveLayerDirectories(graph, cwd, ["src/ui"]);
    expect(dirs).toEqual([uiDir]);
    expect(resolveLayerDirectories(graph, cwd, ["src/ui"])).toBe(dirs);
  });

  it("recomputes for a rebuilt graph", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const graph = emptyGraph();

    const dirs = resolveLayerDirectories(graph, cwd, ["src/ui"]);
    const afterRebuild = resolveLayerDirectories(emptyGraph(), cwd, ["src/ui"]);

    expect(afterRebuild).not.toBe(dirs);
    expect(afterRebuild).toEqual(dirs);
  });
});

describe("collectReExports", () => {
  it("recovers the graph's spelling of a sibling re-exported in another normalization form", () => {
    const base = fs.realpathSync(tempDir("colocate-reexport-nfd-"));
    if (!foldsNormalization(base)) {
      return;
    }

    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });

    const siblingNfd = path.join(fooDir, "Café.ts".normalize("NFD"));
    fs.writeFileSync(siblingNfd, "export const c = 1;\n");
    const indexPath = path.join(fooDir, "index.ts");
    fs.writeFileSync(
      indexPath,
      `export * from "./${"Café".normalize("NFC")}";\n`,
    );
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const local = collectReExports(indexPath, fooDir, graph);

    expect(local).toEqual([siblingNfd]);
    expect(graph.files).toContain(local[0]);
  });

  it("memoises per graph and barrel path", () => {
    const base = fs.realpathSync(tempDir("colocate-reexport-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "A.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "B.ts"), "export const b = 1;\n");
    const indexPath = path.join(fooDir, "index.ts");
    fs.writeFileSync(indexPath, 'export * from "./A";\n');
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const first = collectReExports(indexPath, fooDir, graph);
    const second = collectReExports(indexPath, fooDir, graph);

    expect(second).toBe(first);
  });

  it("keys the memo on the directory argument", () => {
    const base = fs.realpathSync(tempDir("colocate-reexport-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "A.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "B.ts"), "export const b = 1;\n");
    const indexPath = path.join(fooDir, "index.ts");
    fs.writeFileSync(indexPath, 'export * from "./A";\n');
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const first = collectReExports(indexPath, fooDir, graph);
    expect(first).toEqual([path.join(fooDir, "A.ts")]);

    const second = collectReExports(indexPath, srcDir, graph);

    expect(second).not.toBe(first);
    expect(second).not.toEqual(first);
  });

  it("does not re-read the barrel after the file changes", () => {
    const base = fs.realpathSync(tempDir("colocate-reexport-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "A.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "B.ts"), "export const b = 1;\n");
    const indexPath = path.join(fooDir, "index.ts");
    fs.writeFileSync(indexPath, 'export * from "./A";\n');
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const first = collectReExports(indexPath, fooDir, graph);
    expect(first).toEqual([path.join(fooDir, "A.ts")]);

    fs.writeFileSync(
      indexPath,
      'export * from "./A";\nexport * from "./B";\n',
    );
    const second = collectReExports(indexPath, fooDir, graph);

    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it("recomputes for a rebuilt graph", () => {
    const base = fs.realpathSync(tempDir("colocate-reexport-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "A.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "B.ts"), "export const b = 1;\n");
    const indexPath = path.join(fooDir, "index.ts");
    fs.writeFileSync(indexPath, 'export * from "./A";\n');
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const first = collectReExports(indexPath, fooDir, graph);

    fs.writeFileSync(
      indexPath,
      'export * from "./A";\nexport * from "./B";\n',
    );
    const graph2 = buildGraph(srcDir, []);
    const second = collectReExports(indexPath, fooDir, graph2);

    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
    expect(second).toContain(path.join(fooDir, "A.ts"));
    expect(second).toContain(path.join(fooDir, "B.ts"));
  });
});
