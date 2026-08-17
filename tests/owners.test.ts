import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveLayerDirectories } from "../src/lib/owners.js";

const fixtureRoot = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/layer-standalone",
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

  it("rebuilds the cached layer directories when a layer dir mtime changes", () => {
    const cwd = fs.realpathSync(fixtureRoot);
    const uiDir = path.join(cwd, "src/ui");

    const first = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(first).toEqual([uiDir]);

    const later = new Date(Date.now() + 2000);
    fs.utimesSync(uiDir, later, later);

    const second = resolveLayerDirectories(cwd, ["src/ui"]);
    expect(second).not.toBe(first);
    expect(second).toEqual([uiDir]);
  });
});
