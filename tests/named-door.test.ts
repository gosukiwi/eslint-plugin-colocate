import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraph } from "../src/lib/graph.js";
import { isNamedDoor, namedDoorReexports } from "../src/lib/named-door.js";

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

const root = path.join(path.sep, "p", "src");
const at = (...parts: string[]): string => path.join(root, ...parts);

describe("namedDoorReexports", () => {
  it("parses buffer content when provided instead of reading disk", () => {
    const base = fs.realpathSync(tempDir("colocate-named-door-buffer-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    const fooPath = path.join(fooDir, "Foo.ts");
    const sibPath = path.join(fooDir, "sib.ts");
    fs.writeFileSync(fooPath, "export const Foo = 1;\n");
    fs.writeFileSync(sibPath, "export const x = 1;\n");
    fs.writeFileSync(path.join(srcDir, "app.ts"), 'import "./Foo";\n');

    const graph = buildGraph(srcDir, []);
    const buffer = 'export { x } from "./sib";\n';

    expect(namedDoorReexports(fooPath, graph, buffer)).toEqual([
      { target: sibPath, pos: 0 },
    ]);
    expect(namedDoorReexports(fooPath, graph)).toEqual([]);
  });
});

describe("isNamedDoor", () => {
  it("accepts a file named after its directory", () => {
    expect(isNamedDoor(at("Feature", "Feature.ts"))).toBe(true);
  });

  it("rejects an index door", () => {
    expect(isNamedDoor(at("Feature", "index.ts"))).toBe(false);
  });

  it("rejects a non-door sibling", () => {
    expect(isNamedDoor(at("Feature", "helper.ts"))).toBe(false);
  });
});
