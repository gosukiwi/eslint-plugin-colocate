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

// Whether the filesystem finds an NFD-named file through its NFC spelling.
// Probed rather than inferred from ts.sys.useCaseSensitiveFileNames: the two are
// independent axes (a case-sensitive APFS volume still ignores normalization,
// and ext4 ignores neither), and it is this axis that decides whether the
// specifier below resolves at all.
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
  // The only proof that collectReExports canonicalises its resolved targets
  // that does not depend on case folding. It matters because the case tests in
  // ownership.test.ts skip on a case-sensitive volume, and there
  // canonicalGraphPath folds normalization and nothing else - so without this,
  // deleting the call outright leaves the whole suite green on Linux.
  //
  // Nothing here is hand-built: the file is NFD on disk (so the walk records it
  // NFD) while the specifier is NFC, which is the real shape - readdir reports
  // the stored form, an editor writes whatever the author typed, and neither
  // realpath nor the resolver converts between them.
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
    const { local, total } = collectReExports(indexPath, fooDir, graph);

    // Without the fold this is the NFC path the specifier spelled, which is not
    // a graph key - graphHasFile rejects it and mismatchedEntry is lost.
    expect(local).toEqual([siblingNfd]);
    expect(graph.files).toContain(local[0]);
    expect(total).toBe(1);
  });
});
