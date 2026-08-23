import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

describe("plugin", () => {
  it("exports rules.ownership and meta.name", () => {
    expect(plugin.meta.name).toBe("eslint-plugin-colocate");
    expect(plugin.rules.ownership).toBeDefined();
  });
});
