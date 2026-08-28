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
});
