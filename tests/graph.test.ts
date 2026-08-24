import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getGraph,
  getGraphResolutionSettings,
  isTestFile,
  resolveSpecifier,
} from "../src/lib/graph.js";

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph",
);

const jsExtFixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/graph-js-ext",
);

const aliasPrivateFixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/alias-private",
);

function fixture(name: string): string {
  return fs.realpathSync(
    path.join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", name),
  );
}

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

    const graph = getGraph(rootDir, [], aPath);

    expect(graph.importers.get(bPath)).toEqual([aPath]);
    expect(graph.files).toEqual([aPath, bPath]);
    expect(graph.files).not.toContain(cTestPath);

    const cached = getGraph(rootDir, [], aPath);
    expect(cached).toBe(graph);
  });

  it("rebuilds the cached graph when any tracked file changes, not just the current one", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const bPath = path.join(rootDir, "src/b.ts");

    const first = getGraph(rootDir, [], aPath);
    expect(first.importers.get(bPath)).toEqual([aPath]);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(bPath, later, later);

    const second = getGraph(rootDir, [], aPath);
    expect(second).not.toBe(first);
    expect(second.importers.get(bPath)).toEqual([aPath]);

    const cached = getGraph(rootDir, [], aPath);
    expect(cached).toBe(second);
  });

  it("reuses the cached graph when currentFile is outside rootDir", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");

    const first = getGraph(rootDir, [], aPath);

    const outsideFile = path.join(
      os.tmpdir(),
      `colocate-outside-${process.pid}.ts`,
    );
    try {
      fs.writeFileSync(outsideFile, "export const x = 1;\n");
      const second = getGraph(rootDir, [], fs.realpathSync(outsideFile));
      expect(second).toBe(first);
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rebuilds the cached graph when a new production file appears under rootDir", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const newFile = path.join(rootDir, "src/new-file.ts");

    const first = getGraph(rootDir, [], aPath);

    try {
      fs.writeFileSync(newFile, "export const newFile = 1;\n");
      const second = getGraph(rootDir, [], fs.realpathSync(newFile));
      expect(second).not.toBe(first);
      expect(second.files).toContain(fs.realpathSync(newFile));
    } finally {
      fs.rmSync(newFile, { force: true });
    }
  });

  it("rebuilds the cached graph when tsconfig mtime changes", () => {
    const rootDir = fs.realpathSync(path.join(aliasPrivateFixtureRoot, "src"));
    const mainPath = path.join(rootDir, "main.ts");
    const tsconfigPath = path.join(aliasPrivateFixtureRoot, "tsconfig.json");

    const first = getGraph(rootDir, [], mainPath);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(tsconfigPath, later, later);

    const second = getGraph(rootDir, [], mainPath);
    expect(second).not.toBe(first);
  });

  it("resolves the longest matching path alias prefix", () => {
    const rootDir = fixture("alias-longest-prefix");
    const graph = getGraph(rootDir, [], path.join(rootDir, "src/main.ts"));

    expect(graph.importers.get(path.join(rootDir, "src/core/Thing.ts"))).toEqual([
      path.join(rootDir, "src/main.ts"),
    ]);
    expect(
      graph.importers.get(path.join(rootDir, "src/legacy/core/Thing.ts")),
    ).toBeUndefined();
  });

  it("resolves exact path aliases and falls back to later path targets", () => {
    const rootDir = fixture("alias-shapes");
    const mainPath = path.join(rootDir, "src/main.ts");
    const graph = getGraph(rootDir, [], mainPath);

    expect(graph.importers.get(path.join(rootDir, "src/lib/thing.ts"))).toEqual([
      mainPath,
    ]);
    expect(graph.importers.get(path.join(rootDir, "src/other.ts"))).toEqual([
      mainPath,
    ]);
  });

  it("resolves relative imports with .js extension to TypeScript sources", () => {
    const rootDir = fs.realpathSync(jsExtFixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const bPath = path.join(rootDir, "src/b.ts");

    const graph = getGraph(rootDir, [], aPath);

    expect(graph.importers.get(bPath)).toEqual([aPath]);
    expect(graph.files).toEqual([aPath, bPath]);
  });
});

describe("getGraphResolutionSettings", () => {
  it("resolves an aliased specifier the way the graph did, and pins the degraded fallback", () => {
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "colocate-settings-")),
    );
    const srcDir = path.join(base, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(srcDir, "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(
      path.join(base, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );

    const graph = getGraph(srcDir, [], path.join(srcDir, "a.ts"));
    const settings = getGraphResolutionSettings(graph, srcDir);

    expect(settings.options.paths).toEqual({ "@/*": ["src/*"] });
    expect(settings.configPaths).toContain(path.join(base, "tsconfig.json"));
    expect(resolveSpecifier("@/b", srcDir, settings)).toBe(
      path.join(base, "src", "b.ts"),
    );
    // Pinned on purpose: this is the silent-degradation mode the settings
    // exist to avoid. Without them, an aliased import resolves to nothing.
    expect(resolveSpecifier("@/b", srcDir)).toBeUndefined();
  });

  it("computes fresh settings for a graph it never built", () => {
    const base = fs.mkdtempSync(
      path.join(os.tmpdir(), "colocate-settings-fresh-"),
    );
    const srcDir = path.join(base, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "a.ts"), "export const a = 1;\n");

    const settings = getGraphResolutionSettings(
      { files: [], importers: new Map() },
      srcDir,
    );

    expect(settings.options).toBeDefined();
    expect(Array.isArray(settings.configPaths)).toBe(true);
  });
});
