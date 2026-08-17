import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getGraph, isTestFile } from "../src/lib/graph.js";

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph",
);

const jsExtFixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph-js-ext",
);

describe("isTestFile", () => {
  it("returns true when any path segment is __tests__", () => {
    expect(
      isTestFile("src" + path.sep + "__tests__" + path.sep + "a.ts"),
    ).toBe(true);
  });

  it("returns false for paths that do not contain a __tests__ segment", () => {
    expect(isTestFile("src/not_tests/a.ts")).toBe(false);
  });

  it("returns true for .test. or .spec. basenames", () => {
    expect(isTestFile("foo.test.ts")).toBe(true);
  });
});

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

  it("rebuilds the cached graph when the hinted file mtime changes", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const bPath = path.join(rootDir, "src/b.ts");

    const first = getGraph(rootDir, []);
    expect(first.importers.get(bPath)).toEqual([aPath]);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(bPath, later, later);

    const unchangedHint = getGraph(rootDir, [], aPath);
    expect(unchangedHint).toBe(first);

    const second = getGraph(rootDir, [], bPath);
    expect(second).not.toBe(first);
    expect(second.importers.get(bPath)).toEqual([aPath]);
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
