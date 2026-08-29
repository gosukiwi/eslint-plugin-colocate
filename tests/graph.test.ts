import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { getGraph } from "../src/lib/graph-cache.js";
import {
  canonicalGraphPath,
  getGraphResolutionSettings,
} from "../src/lib/graph.js";
import {
  createResolutionSettings,
  resolveSpecifier,
} from "../src/lib/resolve.js";
import { isTestFile } from "../src/lib/scope.js";

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

  it("rebuilds the cached graph when a new production file appears and currentFile is an already-known file", () => {
    const rootDir = fs.realpathSync(fixtureRoot);
    const aPath = path.join(rootDir, "src/a.ts");
    const newFile = path.join(rootDir, "src/new-file.ts");

    const first = getGraph(rootDir, [], aPath);

    try {
      fs.writeFileSync(newFile, "export const newFile = 1;\n");
      const second = getGraph(rootDir, [], aPath);
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

  it("resolves a bare directory specifier to its index file", () => {
    const base = fs.realpathSync(tempDir("colocate-dir-index-"));
    const srcDir = path.join(base, "src");
    const featureDir = path.join(srcDir, "Feature");
    fs.mkdirSync(featureDir, { recursive: true });
    const indexPath = path.join(featureDir, "index.ts");
    fs.writeFileSync(indexPath, "export const x = 1;\n");

    expect(resolveSpecifier("./Feature", srcDir)).toBe(indexPath);
  });
});

describe("canonicalGraphPath", () => {
  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "recovers the graph's own casing for a path resolved through wrong-case specifier text",
    () => {
      const base = fs.realpathSync(tempDir("colocate-canonical-"));
      const srcDir = path.join(base, "src");
      const featureDir = path.join(srcDir, "Feature");
      fs.mkdirSync(featureDir, { recursive: true });
      const entryPath = path.join(featureDir, "Feature.ts");
      const helperPath = path.join(featureDir, "helper.ts");
      fs.writeFileSync(entryPath, "export const x = 1;\n");
      fs.writeFileSync(helperPath, "export const h = 1;\n");
      fs.writeFileSync(
        path.join(srcDir, "app.ts"),
        'import "./Feature/FEATURE";\n',
      );

      const graph = getGraph(srcDir, [], entryPath);
      const settings = getGraphResolutionSettings(graph);

      const wrongCaseEntry = resolveSpecifier(
        "./Feature/FEATURE",
        srcDir,
        settings,
      );
      expect(wrongCaseEntry).toBeDefined();
      expect(wrongCaseEntry).not.toBe(entryPath);
      expect(canonicalGraphPath(graph, wrongCaseEntry as string)).toBe(
        entryPath,
      );

      const wrongCaseHelper = resolveSpecifier(
        "./feature/helper",
        srcDir,
        settings,
      );
      expect(wrongCaseHelper).toBeDefined();
      expect(wrongCaseHelper).not.toBe(helperPath);
      expect(canonicalGraphPath(graph, wrongCaseHelper as string)).toBe(
        helperPath,
      );
    },
  );

  it.skipIf(!ts.sys.useCaseSensitiveFileNames)(
    "returns the path unchanged on a case-sensitive filesystem",
    () => {
      const graph = {
        files: ["/root/Feature/Feature.ts"],
        importers: new Map(),
      };
      expect(canonicalGraphPath(graph, "/root/Feature/FEATURE.ts")).toBe(
        "/root/Feature/FEATURE.ts",
      );
    },
  );

  it("returns the path unchanged when it matches no file in the graph", () => {
    const graph = { files: ["/root/Feature/Feature.ts"], importers: new Map() };
    expect(canonicalGraphPath(graph, "/root/Nowhere/Nowhere.ts")).toBe(
      "/root/Nowhere/Nowhere.ts",
    );
  });

  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "prefers an exact graph member over the lowercase fold",
    () => {
      const graph = {
        files: ["/root/Foo/Index.ts", "/root/Foo/index.ts"],
        importers: new Map(),
      };
      expect(canonicalGraphPath(graph, "/root/Foo/Index.ts")).toBe(
        "/root/Foo/Index.ts",
      );
      expect(canonicalGraphPath(graph, "/root/Foo/index.ts")).toBe(
        "/root/Foo/index.ts",
      );
      expect(canonicalGraphPath(graph, "/root/foo/INDEX.ts")).toBe(
        "/root/Foo/index.ts",
      );
    },
  );

  it("recovers the graph's own spelling across Unicode normalization forms", () => {
    const nfc = "Café"; // é as a single code point
    const nfd = "Café"; // e followed by a combining acute
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));

    const storedNfc = {
      files: [`/root/${nfc}/inner.ts`],
      importers: new Map(),
    };
    expect(canonicalGraphPath(storedNfc, `/root/${nfd}/inner.ts`)).toBe(
      `/root/${nfc}/inner.ts`,
    );

    const storedNfd = {
      files: [`/root/${nfd}/inner.ts`],
      importers: new Map(),
    };
    expect(canonicalGraphPath(storedNfd, `/root/${nfc}/inner.ts`)).toBe(
      `/root/${nfd}/inner.ts`,
    );

    expect(canonicalGraphPath(storedNfc, `/root/${nfc}/inner.ts`)).toBe(
      `/root/${nfc}/inner.ts`,
    );
    expect(canonicalGraphPath(storedNfd, `/root/${nfd}/inner.ts`)).toBe(
      `/root/${nfd}/inner.ts`,
    );

    expect(canonicalGraphPath(storedNfc, "/root/Other/inner.ts")).toBe(
      "/root/Other/inner.ts",
    );
  });
});

describe("getGraphResolutionSettings", () => {
  it("resolves an aliased specifier the way the graph did, and pins the degraded fallback", () => {
    const base = fs.realpathSync(tempDir("colocate-settings-"));
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
    const settings = getGraphResolutionSettings(graph);

    expect(settings.options.paths).toEqual({ "@/*": ["src/*"] });
    expect(settings.configPaths).toContain(path.join(base, "tsconfig.json"));
    expect(resolveSpecifier("@/b", srcDir, settings)).toBe(
      path.join(base, "src", "b.ts"),
    );
    expect(resolveSpecifier("@/b", srcDir)).toBeUndefined();
  });

  it("returns no-project settings for a graph that was never built", () => {
    const base = tempDir("colocate-settings-unprimed-");
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

    const settings = getGraphResolutionSettings({
      files: [],
      importers: new Map(),
    });

    expect(settings.options.paths).toBeUndefined();
    expect(resolveSpecifier("@/b", srcDir, settings)).toBeUndefined();
  });

  it("computes settings from a real root without a graph", () => {
    const base = tempDir("colocate-settings-root-");
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

    const settings = createResolutionSettings(srcDir);

    expect(settings.options.paths).toEqual({ "@/*": ["src/*"] });
    expect(resolveSpecifier("@/b", srcDir, settings)).toBe(
      fs.realpathSync(path.join(base, "src", "b.ts")),
    );
  });
});
