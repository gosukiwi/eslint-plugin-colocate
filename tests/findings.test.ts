import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { singletonDirectoryStats } from "../src/lib/findings.js";
import { buildGraph } from "../src/lib/graph.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

describe("singletonDirectoryStats", () => {
  it("memoises per graph and directory", () => {
    const base = fs.realpathSync(tempDir("colocate-singleton-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(srcDir, "app.ts"), "export const app = 1;\n");

    const graph = buildGraph(srcDir, []);
    const first = singletonDirectoryStats(fooDir, srcDir, [], graph);
    const second = singletonDirectoryStats(fooDir, srcDir, [], graph);

    expect(second).toBe(first);
    expect(first.sourceCount).not.toBe(1);
  });

  it("does not re-walk after a sibling is added", () => {
    const base = fs.realpathSync(tempDir("colocate-singleton-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(srcDir, "app.ts"), "export const app = 1;\n");

    const graph = buildGraph(srcDir, []);
    const first = singletonDirectoryStats(fooDir, srcDir, [], graph);
    expect(first.sourceCount).not.toBe(1);

    fs.writeFileSync(path.join(fooDir, "c.ts"), "export const c = 1;\n");
    const second = singletonDirectoryStats(fooDir, srcDir, [], graph);

    expect(second).toBe(first);
  });

  it("recomputes for a rebuilt graph", () => {
    const base = fs.realpathSync(tempDir("colocate-singleton-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(fooDir, "b.ts"), "export const b = 1;\n");
    fs.writeFileSync(path.join(srcDir, "app.ts"), "export const app = 1;\n");

    const graph = buildGraph(srcDir, []);
    const first = singletonDirectoryStats(fooDir, srcDir, [], graph);

    fs.writeFileSync(path.join(fooDir, "c.ts"), "export const c = 1;\n");
    const graph2 = buildGraph(srcDir, []);
    const second = singletonDirectoryStats(fooDir, srcDir, [], graph2);

    expect(second).not.toBe(first);
  });

  it("does not treat a CSS companion as a second source file, and still sees the stylesheet", () => {
    const base = fs.realpathSync(tempDir("colocate-singleton-memo-"));
    const srcDir = path.join(base, "src");
    const widgetDir = path.join(srcDir, "Widget");
    fs.mkdirSync(widgetDir, { recursive: true });
    fs.writeFileSync(
      path.join(widgetDir, "Widget.ts"),
      "export const w = 1;\n",
    );
    fs.writeFileSync(
      path.join(widgetDir, "Widget.module.css"),
      ".w {}\n",
    );
    fs.writeFileSync(path.join(srcDir, "app.ts"), "export const app = 1;\n");

    const graph = buildGraph(srcDir, []);
    const stats = singletonDirectoryStats(widgetDir, srcDir, [], graph);

    expect(stats.sourceCount).toBe(1);
    expect(stats.hasStylesheet).toBe(true);
  });

  it("ignored files do not count as a second source", () => {
    const base = fs.realpathSync(tempDir("colocate-singleton-memo-"));
    const srcDir = path.join(base, "src");
    const fooDir = path.join(srcDir, "Foo");
    fs.mkdirSync(fooDir, { recursive: true });
    fs.writeFileSync(path.join(fooDir, "Foo.ts"), "export const foo = 1;\n");
    fs.writeFileSync(path.join(fooDir, "skip.ts"), "export const skip = 1;\n");
    fs.writeFileSync(path.join(srcDir, "app.ts"), "export const app = 1;\n");

    const graph = buildGraph(srcDir, ["**/skip.ts"]);
    const stats = singletonDirectoryStats(fooDir, srcDir, ["**/skip.ts"], graph);

    expect(stats.sourceCount).toBe(1);
    expect(stats.hasStylesheet).toBe(false);
  });
});
