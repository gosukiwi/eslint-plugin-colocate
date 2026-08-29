import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stampIsAmbiguous } from "../src/lib/graph-cache.js";
import plugin from "../src/index.js";

const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("plugin surface", () => {
  it("reports the version from package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { name: string; version: string };

    expect(plugin.meta.name).toBe(pkg.name);
    expect(plugin.meta.version).toBe(pkg.version);
  });

  it("exposes the ownership rule with documentation metadata", () => {
    const rule = plugin.rules.ownership;
    expect(rule.meta?.type).toBe("problem");
    expect(rule.meta?.docs?.url).toMatch(/^https:\/\//);
    expect(Object.keys(rule.meta?.messages ?? {}).sort()).toEqual([
      "mismatchedEntry",
      "privateOutsideOwner",
      "sharedInsideOwner",
      "sharedTooHigh",
      "singletonFolder",
    ]);
  });

  it("exposes the entry rule with documentation metadata", () => {
    const rule = plugin.rules.entry;
    expect(rule.meta?.type).toBe("problem");
    expect(rule.meta?.docs?.url).toMatch(/^https:\/\//);
    expect(Object.keys(rule.meta?.messages ?? {}).sort()).toEqual([
      "reachesPastEntry",
    ]);
  });

  it("ships no configs", () => {
    expect((plugin as { configs?: unknown }).configs).toBeUndefined();
  });
});

describe("stampIsAmbiguous", () => {
  const builtAt = 5_000_500;

  it("distrusts a stamp written in the same second as the build", () => {
    expect(stampIsAmbiguous(5_000_000, builtAt, true, builtAt)).toBe(true);
  });

  it("trusts a stamp from an earlier second", () => {
    expect(stampIsAmbiguous(4_999_000, builtAt, true, builtAt)).toBe(false);
  });

  it("trusts a stamp from a later second", () => {
    expect(stampIsAmbiguous(5_002_000, builtAt, true, builtAt)).toBe(false);
  });

  it("distrusts a stamp written in a later second that is still within the rebuild", () => {
    expect(stampIsAmbiguous(5_002_000, builtAt, true, 5_002_500)).toBe(true);
  });

  it("trusts everything when timestamps are fine-grained", () => {
    expect(stampIsAmbiguous(5_000_000, builtAt, false, builtAt)).toBe(false);
  });
});
