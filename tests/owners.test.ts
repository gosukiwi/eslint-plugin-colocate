import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/graph.js";
import {
  collectLayerDirectories,
  resolveLayerDirectories,
} from "../src/lib/owners.js";

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
