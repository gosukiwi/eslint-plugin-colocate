import path from "node:path";
import { describe, expect, it } from "vitest";
import { isNamedDoor } from "../src/lib/named-door.js";

const root = path.join(path.sep, "p", "src");
const at = (...parts: string[]): string => path.join(root, ...parts);

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
