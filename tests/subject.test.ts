import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Rule } from "eslint";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSubject, resolvedLintRoot } from "../src/lib/subject.js";

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function context(
  filename: string,
  cwd: string,
  options: { root?: string; ignore?: string[] }[],
  sourceCode: object,
): Rule.RuleContext {
  return {
    filename,
    cwd,
    options,
    sourceCode,
  } as Rule.RuleContext;
}

function writeSrcTree(base: string): void {
  fs.mkdirSync(path.join(base, "src"), { recursive: true });
  fs.writeFileSync(path.join(base, "src/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(base, "src/b.ts"), "export const b = 1;\n");
}

describe("resolveSubject", () => {
  it("reuses one Subject for the same parse object and options", () => {
    const base = tempDir("subject-reuse-");
    writeSrcTree(base);
    const cwd = base;
    const filename = path.join(base, "src/a.ts");
    const token = {};
    const first = context(filename, cwd, [{ root: "src" }], token);
    const second = context(filename, cwd, [{ root: "src" }], token);

    const subjectA = resolveSubject(first);
    const subjectB = resolveSubject(second);

    expect(subjectA).toBeDefined();
    expect(subjectB).toBeDefined();
    expect(subjectB).toBe(subjectA);
  });

  it("does not reuse across parse objects", () => {
    const base = tempDir("subject-parse-");
    writeSrcTree(base);
    const cwd = base;
    const filename = path.join(base, "src/a.ts");
    const a = context(filename, cwd, [{ root: "src" }], {});
    const b = context(filename, cwd, [{ root: "src" }], {});

    const subjectA = resolveSubject(a);
    const subjectB = resolveSubject(b);

    expect(subjectA).toBeDefined();
    expect(subjectB).toBeDefined();
    expect(subjectB).not.toBe(subjectA);
    expect(subjectB!.file).toEqual(subjectA!.file);
    expect(subjectB!.rootDir).toEqual(subjectA!.rootDir);
    expect(subjectB!.realRootDir).toEqual(subjectA!.realRootDir);
  });

  it("does not reuse when ignore differs on the same parse", () => {
    const base = tempDir("subject-ignore-");
    writeSrcTree(base);
    const cwd = base;
    const filename = path.join(base, "src/a.ts");
    const token = {};
    const first = context(filename, cwd, [{ root: "src" }], token);
    const second = context(
      filename,
      cwd,
      [{ root: "src", ignore: ["**/b.ts"] }],
      token,
    );

    const subjectA = resolveSubject(first);
    const subjectB = resolveSubject(second);

    expect(subjectA).toBeDefined();
    expect(subjectB).toBeDefined();
    expect(subjectB).not.toBe(subjectA);
  });

  it("does not reuse when root differs on the same parse", () => {
    const base = tempDir("subject-root-");
    writeSrcTree(base);
    fs.mkdirSync(path.join(base, "other"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "other/a.ts"),
      "export const a = 1;\n",
    );
    const cwd = base;
    const filename = path.join(base, "src/a.ts");
    const token = {};
    const first = context(filename, cwd, [{ root: "src" }], token);
    const second = context(filename, cwd, [{ root: "other" }], token);

    const subjectA = resolveSubject(first);
    const subjectB = resolveSubject(second);

    expect(subjectA).toBeDefined();
    expect(subjectB).toBeUndefined();
    expect(subjectB).not.toBe(subjectA);
  });
});

describe("resolvedLintRoot", () => {
  it("memoises per cwd and root option", () => {
    const base = tempDir("root-memo-");
    fs.mkdirSync(path.join(base, "src"), { recursive: true });
    const expectedRootDir = path.join(base, "src");
    const expectedRealRootDir = fs.realpathSync(expectedRootDir);

    const first = resolvedLintRoot(base, "src");
    const second = resolvedLintRoot(base, "src");

    expect(second).toBe(first);
    expect(first).toBeDefined();
    expect(first!.rootDir).toBe(expectedRootDir);
    expect(first!.realRootDir).toBe(expectedRealRootDir);
  });

  it("does not reuse across cwd", () => {
    const baseA = tempDir("root-cwd-a-");
    const baseB = tempDir("root-cwd-b-");
    fs.mkdirSync(path.join(baseA, "src"), { recursive: true });
    fs.mkdirSync(path.join(baseB, "src"), { recursive: true });

    const rootA = resolvedLintRoot(baseA, "src");
    const rootB = resolvedLintRoot(baseB, "src");

    expect(rootA).toBeDefined();
    expect(rootB).toBeDefined();
    expect(rootB).not.toBe(rootA);
  });

  it("does not store a failed lookup", () => {
    const base = tempDir("root-fail-");

    expect(resolvedLintRoot(base, "src")).toBeUndefined();

    fs.mkdirSync(path.join(base, "src"));
    const result = resolvedLintRoot(base, "src");

    expect(result).toBeDefined();
    expect(result!.rootDir).toBe(path.join(base, "src"));
    expect(result!.realRootDir).toBe(fs.realpathSync(path.join(base, "src")));
  });
});
