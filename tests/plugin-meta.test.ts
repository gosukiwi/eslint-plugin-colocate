import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
});
