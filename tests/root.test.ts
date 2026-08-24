import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRootDir } from "../src/lib/root.js";

describe("resolveRootDir", () => {
  it("returns an absolute root unchanged", () => {
    expect(resolveRootDir("/tmp/whatever", "/anywhere")).toBe("/tmp/whatever");
  });

  it("finds a relative root from a subdirectory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-root-"));
    fs.writeFileSync(path.join(base, "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src", "nested"), { recursive: true });

    expect(resolveRootDir("src", path.join(base, "src", "nested"))).toBe(
      path.join(base, "src"),
    );
  });

  it("stops at the project boundary instead of escaping the checkout", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "colocate-root-"));
    fs.mkdirSync(path.join(base, "project"), { recursive: true });
    fs.writeFileSync(path.join(base, "project", "package.json"), "{}");
    fs.mkdirSync(path.join(base, "src"));

    // "src" exists above the project, but the walk must not reach it.
    expect(resolveRootDir("src", path.join(base, "project"))).toBe(
      path.join(base, "project", "src"),
    );
  });
});
