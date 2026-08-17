import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveLayerDirectories } from "../src/lib/owners.js";

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/layer-standalone",
);

const nestedLayerRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/layer-single-consumer",
);

describe("resolveLayerDirectories", () => {
  it("caches layer directories by cwd + layerGlobs", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");

    const dirs = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(dirs).toEqual([uiDir]);

    const cached = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(cached).toBe(dirs);
  });

  it("returns the cached layer directories even when a layer dir mtime changes", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");

    const first = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(first).toEqual([uiDir]);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(uiDir, later, later);

    const second = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(second).toBe(first);
  });

  it("expands single-segment * globs to child directories", () => {
    const cwd = fs.realpathSync(nestedLayerRoot);
    const buttonDir = path.join(cwd, "src/ui/Button");

    const dirs = resolveLayerDirectories(cwd, ["src/ui/*"]);
    expect(dirs).toEqual([buttonDir]);
  });

  it("resolves ** globs by walking from cwd", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");

    const dirs = resolveLayerDirectories(cwd, ["**/ui"]);
    expect(dirs).toEqual([uiDir]);
  });
});
