import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAtOrInsideDir, isInsideDir } from "../src/lib/paths.js";

const sep = path.sep;
const at = (...parts: string[]): string => path.join(sep, ...parts);

describe("isInsideDir", () => {
  it("accepts a file below the directory", () => {
    expect(isInsideDir(at("p", "src", "a.ts"), at("p", "src"))).toBe(true);
  });

  it("accepts a file several levels below", () => {
    expect(isInsideDir(at("p", "src", "x", "y", "a.ts"), at("p", "src"))).toBe(
      true,
    );
  });

  it("rejects the directory itself", () => {
    expect(isInsideDir(at("p", "src"), at("p", "src"))).toBe(false);
  });

  it("rejects a sibling whose name merely starts with the directory's", () => {
    expect(isInsideDir(at("p", "srcx", "a.ts"), at("p", "src"))).toBe(false);
  });

  it("handles a directory that already ends in a separator", () => {
    expect(isInsideDir(at("a.ts"), sep)).toBe(true);
    expect(isInsideDir(at("sub", "a.ts"), sep)).toBe(true);
  });
});

describe("isAtOrInsideDir", () => {
  it("accepts the directory itself", () => {
    expect(isAtOrInsideDir(at("p", "src"), at("p", "src"))).toBe(true);
  });

  it("accepts a file inside it", () => {
    expect(isAtOrInsideDir(at("p", "src", "a.ts"), at("p", "src"))).toBe(true);
  });

  it("rejects a prefix-sharing sibling", () => {
    expect(isAtOrInsideDir(at("p", "srcx"), at("p", "src"))).toBe(false);
  });

  it("treats a path under a separator-terminated root as within it", () => {
    expect(isAtOrInsideDir(at("sub", "a.ts"), sep)).toBe(true);
    expect(isAtOrInsideDir(sep, sep)).toBe(true);
  });
});
