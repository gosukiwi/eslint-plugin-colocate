import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/lib/graph.js";
import { findCrossedGate, getGates, isEntryFile } from "../src/lib/gates.js";

const root = path.join(path.sep, "p", "src");
const at = (...parts: string[]): string => path.join(root, ...parts);

function graphOf(...files: string[]): Graph {
  return { files: [...files].sort(), importers: new Map() };
}

describe("isEntryFile", () => {
  it("accepts a file named after its directory", () => {
    expect(isEntryFile(at("Feature", "Feature.ts"))).toBe(true);
  });

  it("accepts an index regardless of extension", () => {
    expect(isEntryFile(at("Feature", "index.tsx"))).toBe(true);
  });

  it("rejects any other sibling", () => {
    expect(isEntryFile(at("Feature", "helper.ts"))).toBe(false);
  });

  it("does not care who imports the entry", () => {
    expect(isEntryFile(at("Untouched", "index.ts"))).toBe(true);
  });
});

describe("getGates", () => {
  it("maps each directory holding an entry to that entry", () => {
    const graph = graphOf(at("Feature", "Feature.ts"), at("Feature", "helper.ts"));
    expect(getGates(graph).get(at("Feature"))).toBe(at("Feature", "Feature.ts"));
  });

  it("prefers index when a directory has two doors", () => {
    const graph = graphOf(at("Feature", "Feature.ts"), at("Feature", "index.ts"));
    expect(getGates(graph).get(at("Feature"))).toBe(at("Feature", "index.ts"));
  });

  it("does not gate a directory with no entry", () => {
    const graph = graphOf(at("tabs", "One.ts"), at("tabs", "Two.ts"));
    expect(getGates(graph).has(at("tabs"))).toBe(false);
  });

  it("memoises the map per graph", () => {
    const graph = graphOf(at("Feature", "Feature.ts"));
    expect(getGates(graph)).toBe(getGates(graph));
  });

  it("prefers index over a directory-named sibling even when index sorts first", () => {
    const graph = graphOf(at("zed", "index.ts"), at("zed", "zed.ts"));
    expect(getGates(graph).get(at("zed"))).toBe(at("zed", "index.ts"));
  });

  it("picks the first index spelling in sorted order when both exist", () => {
    const graph = graphOf(at("Feature", "index.ts"), at("Feature", "index.tsx"));
    expect(getGates(graph).get(at("Feature"))).toBe(at("Feature", "index.ts"));
  });
});

describe("findCrossedGate", () => {
  const graph = graphOf(
    at("app.ts"),
    at("Outer", "index.ts"),
    at("Outer", "Inner", "Inner.ts"),
    at("Outer", "Inner", "deep.ts"),
  );

  it("reports the innermost gate the importer is outside of", () => {
    const crossed = findCrossedGate(
      at("Outer", "Inner", "deep.ts"),
      at("app.ts"),
      graph,
      root,
    );
    expect(crossed).toEqual({
      dir: at("Outer", "Inner"),
      entry: at("Outer", "Inner", "Inner.ts"),
    });
  });

  it("allows an entry file as a target", () => {
    expect(
      findCrossedGate(at("Outer", "Inner", "Inner.ts"), at("app.ts"), graph, root),
    ).toBeUndefined();
  });

  it("allows an importer that lives inside the gate", () => {
    expect(
      findCrossedGate(
        at("Outer", "Inner", "deep.ts"),
        at("Outer", "Inner", "Inner.ts"),
        graph,
        root,
      ),
    ).toBeUndefined();
  });

  it("reports the inner gate when the importer sits inside the outer one", () => {
    const crossed = findCrossedGate(
      at("Outer", "Inner", "deep.ts"),
      at("Outer", "index.ts"),
      graph,
      root,
    );
    expect(crossed).toEqual({
      dir: at("Outer", "Inner"),
      entry: at("Outer", "Inner", "Inner.ts"),
    });
  });

  it("finds nothing when no directory on the path has an entry", () => {
    const flat = graphOf(at("tabs", "One.ts"), at("tabs", "Two.ts"), at("app.ts"));
    expect(
      findCrossedGate(at("tabs", "One.ts"), at("app.ts"), flat, root),
    ).toBeUndefined();
  });

  it("treats an importer inside a root-level gate as inside it", () => {
    const fsRoot = path.sep;
    const atRoot = (name: string): string => path.join(fsRoot, name);
    const rooted = graphOf(atRoot("index.ts"), atRoot("other.ts"));
    expect(
      findCrossedGate(atRoot("other.ts"), atRoot("importer.ts"), rooted, fsRoot),
    ).toBeUndefined();
  });

  it("does not treat a name-prefix sibling as inside the gate", () => {
    const siblings = graphOf(
      at("Feature", "Feature.ts"),
      at("Feature", "helper.ts"),
      at("Featurex", "importer.ts"),
    );
    expect(
      findCrossedGate(
        at("Feature", "helper.ts"),
        at("Featurex", "importer.ts"),
        siblings,
        root,
      ),
    ).toEqual({
      dir: at("Feature"),
      entry: at("Feature", "Feature.ts"),
    });
  });
});
