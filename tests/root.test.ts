import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRootDir } from "../src/lib/root.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-root-"));
  created.push(dir);
  return dir;
}

describe("resolveRootDir", () => {
  it("returns an absolute root unchanged", () => {
    expect(resolveRootDir("/tmp/whatever", "/anywhere")).toBe("/tmp/whatever");
  });

  it("finds a relative root from a subdirectory", () => {
    const base = tempDir();
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src", "nested"), { recursive: true });

    expect(resolveRootDir("src", path.join(base, "src", "nested"))).toBe(
      path.join(base, "src"),
    );
  });

  it("stops at the project boundary instead of escaping the checkout", () => {
    const base = tempDir();
    const project = path.join(base, "project");
    const deep = path.join(project, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src"));

    expect(resolveRootDir("src", deep)).toBe(path.join(deep, "src"));
  });
});
