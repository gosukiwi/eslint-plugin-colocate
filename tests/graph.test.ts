import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getGraph } from "../src/lib/graph.js";

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph",
);

const jsExtFixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph-js-ext",
);

describe("getGraph", () => {
  it("builds production import graph and caches by root + ignoreGlobs", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const bPath = path.join(rootDir, "src/b.ts");
    const cTestPath = path.join(rootDir, "src/c.test.ts");

    const graph = getGraph(rootDir, []);

    expect(graph.importers.get(bPath)).toEqual([aPath]);
    expect(graph.files).toEqual([aPath, bPath]);
    expect(graph.files).not.toContain(cTestPath);

    const cached = getGraph(rootDir, []);
    expect(cached).toBe(graph);
  });

  it("resolves relative imports with .js extension to TypeScript sources", () => {
    const rootDir = fs.realpathSync(jsExtFixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const bPath = path.join(rootDir, "src/b.ts");

    const graph = getGraph(rootDir, []);

    expect(graph.importers.get(bPath)).toEqual([aPath]);
    expect(graph.files).toEqual([aPath, bPath]);
  });
});
