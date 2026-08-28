import { describe, expect, it } from "vitest";
import { extractSpecifiers } from "../src/lib/parse.js";

describe("extractSpecifiers", () => {
  it("records type-position import()", () => {
    expect(
      extractSpecifiers('export type X = import("./mod").T;\n', "a.ts"),
    ).toEqual(["./mod"]);
  });

  it("records typeof import()", () => {
    expect(
      extractSpecifiers('export type X = typeof import("./mod");\n', "a.ts"),
    ).toEqual(["./mod"]);
  });

  it("records a type-position import() in a type annotation", () => {
    expect(
      extractSpecifiers('let v: import("./mod").T;\n', "a.ts"),
    ).toEqual(["./mod"]);
  });

  it("ignores a type-position import() whose argument is not a string literal", () => {
    expect(
      extractSpecifiers("export type X = import(foo).T;\n", "a.ts"),
    ).toEqual([]);
  });

  it("records quoted import() and require() specifiers", () => {
    expect(extractSpecifiers('import("./mod");\n', "a.ts")).toEqual(["./mod"]);
    expect(extractSpecifiers('require("./mod");\n', "a.js")).toEqual(["./mod"]);
  });

  it("records import() with a no-substitution template specifier", () => {
    expect(extractSpecifiers("import(`./mod`);\n", "a.ts")).toEqual(["./mod"]);
  });

  it("records require() with a no-substitution template specifier", () => {
    expect(extractSpecifiers("require(`./mod`);\n", "a.js")).toEqual(["./mod"]);
  });

  it("records type-position import() with a no-substitution template specifier", () => {
    expect(
      extractSpecifiers("export type X = import(`./mod`).T;\n", "a.ts"),
    ).toEqual(["./mod"]);
  });

  it("records the cooked value of a no-substitution template specifier", () => {
    expect(
      extractSpecifiers("import(`./hel\\u0070er`);\n", "a.ts"),
    ).toEqual(["./helper"]);
  });

  it("ignores a template specifier with substitutions", () => {
    expect(extractSpecifiers("import(`./mod${y}`);\n", "a.ts")).toEqual([]);
  });
});
