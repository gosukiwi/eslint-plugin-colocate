import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stampIsAmbiguous } from "../src/lib/graph.js";
import plugin from "../src/index.js";

const repoRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("plugin surface", () => {
  it("reports the version from package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { name: string; version: string };

    // meta.version is hardcoded, so this is the only thing keeping it honest
    // after a version bump.
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

  // Adding a rule to a shipped preset would make every future rule a breaking
  // change, so the plugin deliberately exports none.
  it("ships no configs", () => {
    expect((plugin as { configs?: unknown }).configs).toBeUndefined();
  });
});

describe("stampIsAmbiguous", () => {
  const builtAt = 5_000_500;

  it("distrusts a stamp written in the same second as the build", () => {
    expect(stampIsAmbiguous(5_000_000, builtAt, true)).toBe(true);
  });

  it("trusts a stamp from an earlier second", () => {
    expect(stampIsAmbiguous(4_999_000, builtAt, true)).toBe(false);
  });

  // A clock-skewed future timestamp is stable, so distrusting it would rebuild
  // the graph on every lint forever.
  it("trusts a stamp from a later second", () => {
    expect(stampIsAmbiguous(5_002_000, builtAt, true)).toBe(false);
  });

  it("trusts everything when timestamps are fine-grained", () => {
    expect(stampIsAmbiguous(5_000_000, builtAt, false)).toBe(false);
  });
});
