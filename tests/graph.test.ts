import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalGraphPath,
  getGraph,
  getGraphResolutionSettings,
  isTestFile,
  resolveSpecifier,
} from "../src/lib/graph.js";

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

  // The entry rule leans on a bare directory specifier resolving through to
  // its index - if resolution ever stopped doing that, the specifier would
  // resolve to undefined and every rule built on it would silently stop
  // seeing the import, not report it wrong.
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
      // Reproduces the exact defect this exists to close: fs.realpathSync (what
      // safeRealpath/resolveSpecifier use) does not fold case on macOS - only
      // its .native variant does - so resolving "./FEATURE" against a file
      // actually named Feature.ts hands back .../FEATURE/FEATURE.ts, not the
      // path the graph itself uses as a gate/owner key.
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
      const settings = getGraphResolutionSettings(graph, srcDir);

      // The false positive: resolving the wrong-case specifier that actually
      // lands on the door.
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

      // The false negative: resolving a wrong-case directory segment on a
      // genuine crossing must still land on the graph's real helper path, or
      // a gate lookup keyed on its directory silently misses.
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

  // Hand-built rather than written to disk on purpose: the two files differ only
  // by case, which a case-insensitive volume cannot hold at once. The graph can
  // still contain both, because ts.sys.useCaseSensitiveFileNames is probed where
  // TypeScript itself is installed, not where the project lives - a
  // case-sensitive mount under a case-insensitive host, or Windows per-directory
  // case sensitivity, makes this the real shape.
  it.skipIf(ts.sys.useCaseSensitiveFileNames)(
    "prefers an exact graph member over the lowercase fold",
    () => {
      // Foo/index.ts is the door; Foo/Index.ts is an ordinary internal file,
      // since "Index" is neither "index" nor "Foo". They share one lowercase
      // key, and the fold keeps whichever came last - so without an exact-match
      // guard one silently becomes the other: the internal file folds onto the
      // door and its crossing vanishes, or the door folds onto the internal file
      // and gets reported as reaching past itself.
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
      // The recovery path itself must still work for a non-member.
      expect(canonicalGraphPath(graph, "/root/foo/INDEX.ts")).toBe(
        "/root/Foo/index.ts",
      );
    },
  );

  // Runs on every platform, unlike the case tests above: normalization is folded
  // regardless of whether the filesystem ignores case, because `readdir` reports
  // whatever form the filesystem stores while a specifier carries whatever form
  // the author's editor wrote, and neither realpath nor the resolver converts
  // between them. Both directions matter - a project can be checked out either
  // way - so both are asserted.
  it("recovers the graph's own spelling across Unicode normalization forms", () => {
    const nfc = "Café"; // é as a single code point
    const nfd = "Café"; // e followed by a combining acute
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));

    // Graph stored NFC, specifier resolved NFD.
    const storedNfc = {
      files: [`/root/${nfc}/inner.ts`],
      importers: new Map(),
    };
    expect(canonicalGraphPath(storedNfc, `/root/${nfd}/inner.ts`)).toBe(
      `/root/${nfc}/inner.ts`,
    );

    // Graph stored NFD, specifier resolved NFC.
    const storedNfd = {
      files: [`/root/${nfd}/inner.ts`],
      importers: new Map(),
    };
    expect(canonicalGraphPath(storedNfd, `/root/${nfc}/inner.ts`)).toBe(
      `/root/${nfd}/inner.ts`,
    );

    // An exact member still wins, so neither spelling is rewritten when the
    // graph already holds it verbatim.
    expect(canonicalGraphPath(storedNfc, `/root/${nfc}/inner.ts`)).toBe(
      `/root/${nfc}/inner.ts`,
    );
    expect(canonicalGraphPath(storedNfd, `/root/${nfd}/inner.ts`)).toBe(
      `/root/${nfd}/inner.ts`,
    );

    // Still unchanged for a path the graph does not hold in any form.
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
    const base = tempDir("colocate-settings-fresh-");
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
