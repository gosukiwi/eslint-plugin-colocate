import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../src/index.js";
import { ownershipFindings } from "../src/lib/findings.js";
import { findCrossedGate, getGates } from "../src/lib/gates.js";
import { getGraph } from "../src/lib/graph-cache.js";
import {
  buildGraphFromFiles,
  canonicalGraphPath,
  getGraphResolutionSettings,
  type Graph,
} from "../src/lib/graph.js";
import { getOwner, getShells } from "../src/lib/owners.js";
import { extractSpecifiers, parseSourceFile } from "../src/lib/parse.js";
import { createResolutionSettings, resolveSpecifier } from "../src/lib/resolve.js";
import { safeReadFile } from "../src/lib/fs-safe.js";
import type { Subject } from "../src/lib/subject.js";
import { collectSourceFiles } from "../src/lib/walk.js";

const CASE_DIR = path.join(fs.realpathSync("/tmp"), "fol-perf");
const SIZES = (process.env.SIZES ?? "120,400,1000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

function now(): number {
  return performance.now();
}

function ms(start: number): string {
  return `${(now() - start).toFixed(1)}ms`;
}

function pad(label: string): string {
  return label.padEnd(36);
}

function writeTree(root: string, targetFiles: number): { files: string[] } {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const featureCount = Math.max(8, Math.floor(targetFiles / 6));
  const helpersPerFeature = 3;
  const sharedCount = Math.max(4, Math.floor(featureCount / 8));
  const pageCount = Math.max(4, Math.floor(featureCount / 6));

  const files: Record<string, string> = {};
  const filler = (name: string): string =>
    `export const ${name.replace(/\W/g, "_")} = {\n${Array.from(
      { length: 12 },
      (_, i) => `  k${i}: ${i},\n`,
    ).join("")}};\n`;

  files["tsconfig.json"] = JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        paths: { "@shared/*": ["./src/shared/*"] },
      },
      include: ["src"],
    },
    null,
    2,
  );

  const featureNames: string[] = [];
  for (let i = 0; i < featureCount; i++) {
    const name = `F${i}`;
    featureNames.push(name);
    const dir = `src/features/${name}`;
    const helperImports = Array.from(
      { length: helpersPerFeature },
      (_, h) => `import { ${name}_h${h} } from "./h${h}";`,
    ).join("\n");
    files[`${dir}/${name}.ts`] =
      `${helperImports}\nexport function ${name}() { return ${i}; }\n${filler(name)}`;
    for (let h = 0; h < helpersPerFeature; h++) {
      files[`${dir}/h${h}.ts`] =
        `export function ${name}_h${h}() { return ${h}; }\n${filler(`${name}_h${h}`)}`;
    }
    files[`${dir}/index.ts`] = `export * from "./${name}";\n`;
  }

  for (let i = 0; i < sharedCount; i++) {
    const a = featureNames[i % featureNames.length];
    const b = featureNames[(i + Math.floor(featureCount / 3)) % featureNames.length];
    files[`src/shared/util${i}.ts`] =
      `export const util${i} = ${i};\n${filler(`util${i}`)}`;
    files[`src/features/${a}/${a}.ts`] +=
      `import { util${i} } from "@shared/util${i}";\nvoid util${i};\n`;
    files[`src/features/${b}/${b}.ts`] +=
      `import { util${i} } from "@shared/util${i}";\nvoid util${i};\n`;
  }

  const pageNames: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    const name = `P${i}`;
    pageNames.push(name);
    const f1 = featureNames[i % featureNames.length];
    const f2 = featureNames[(i + 1) % featureNames.length];
    files[`src/pages/${name}/${name}.ts`] =
      `import { ${f1} } from "../../features/${f1}";\n` +
      `import { ${f2} } from "../../features/${f2}";\n` +
      `export function ${name}() { return ${f1}() + ${f2}(); }\n${filler(name)}`;
  }

  files["src/App.ts"] =
    pageNames
      .map((name) => `import { ${name} } from "./pages/${name}/${name}";`)
      .join("\n") +
    `\nexport function App() { return ${pageNames.map((n) => `${n}()`).join(" + ")}; }\n`;
  files["src/main.ts"] = `import { App } from "./App";\nApp();\n`;

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  return {
    files: Object.keys(files)
      .filter((rel) => rel.endsWith(".ts") && rel !== "tsconfig.json")
      .map((rel) => path.join(root, rel)),
  };
}

function countSourceFilesShallowish(dir: string, rootDir: string): number {
  let sourceCount = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".ts")) {
        sourceCount += 1;
      }
    }
  }
  void rootDir;
  return sourceCount;
}

function makeSubject(file: string, rootDir: string, graph: Graph): Subject {
  return {
    rootDir,
    realRootDir: rootDir,
    file,
    lintedPath: file,
    ignore: [],
    graph: () => graph,
    covers: (filePath) => graph.files.includes(filePath),
    display: (filePath) => path.relative(rootDir, filePath).split(path.sep).join("/"),
  };
}

function makeESLint(cwd: string, rules: "both" | "none" | "ownership" | "entry"): ESLint {
  const enabled: Record<string, unknown> = {};
  if (rules === "both" || rules === "ownership") {
    enabled["colocate/ownership"] = ["error", { root: "src" }];
  }
  if (rules === "both" || rules === "entry") {
    enabled["colocate/entry"] = ["error", { root: "src" }];
  }
  if (rules === "none") {
    enabled["colocate/ownership"] = "off";
  }

  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,ts}"],
        plugins: { colocate: plugin },
        rules: enabled,
        languageOptions: {
          parser: tsParser,
          parserOptions: { sourceType: "module", ecmaVersion: 2022 },
        },
      },
    ],
  });
}

async function measureSize(targetFiles: number): Promise<void> {
  const root = path.join(CASE_DIR, String(targetFiles));
  const srcRoot = path.join(root, "src");
  const writeStart = now();
  const { files } = writeTree(root, targetFiles);
  const writeMs = now() - writeStart;

  console.log(`\n=== ~${files.length} ts files  (target ${targetFiles}) ===`);
  console.log(`${pad("write tree")} ${writeMs.toFixed(1)}ms`);

  const firstFile = path.join(srcRoot, "main.ts");
  const coldGraphStart = now();
  getGraph(srcRoot, [], firstFile);
  console.log(`${pad("getGraph cold (walk+stamp+build)")} ${ms(coldGraphStart)}`);

  const walked = collectSourceFiles(srcRoot, []);
  const burstStart = now();
  for (const file of walked.files) {
    if (file === firstFile) {
      continue;
    }
    getGraph(srcRoot, [], file);
  }
  console.log(
    `${pad("getGraph rest of first pass")} ${(now() - burstStart).toFixed(1)}ms  (${walked.files.length - 1} calls)`,
  );

  await new Promise((r) => setTimeout(r, 120));
  const revalidateStart = now();
  getGraph(srcRoot, [], firstFile);
  console.log(`${pad("getGraph revalidate (new pass)")} ${ms(revalidateStart)}`);

  const walkStart = now();
  collectSourceFiles(srcRoot, []);
  console.log(
    `${pad("walk (repeat)")} ${(now() - walkStart).toFixed(1)}ms  (${walked.files.length} files, ${walked.dirStamps.size} dirs)`,
  );

  const settingsStart = now();
  const settings = createResolutionSettings(srcRoot);
  const settingsMs = now() - settingsStart;

  let readMs = 0;
  let extractMs = 0;
  let resolveMs = 0;
  let specifiers = 0;
  const resolvedHits = { ok: 0, miss: 0 };
  const contents = new Map<string, string>();

  for (const file of walked.files) {
    const tRead = now();
    const content = safeReadFile(file);
    readMs += now() - tRead;
    if (content === undefined) {
      continue;
    }
    contents.set(file, content);
    const tExtract = now();
    const specs = extractSpecifiers(content, file);
    extractMs += now() - tExtract;
    specifiers += specs.length;
    const fromDir = path.dirname(file);
    for (const specifier of specs) {
      const tRes = now();
      const resolved = resolveSpecifier(specifier, fromDir, settings);
      resolveMs += now() - tRes;
      if (resolved === undefined) {
        resolvedHits.miss += 1;
      } else {
        resolvedHits.ok += 1;
      }
    }
  }

  const parseStart = now();
  for (const [file, content] of contents) {
    parseSourceFile(file, content);
  }
  const parseMs = now() - parseStart;

  console.log(`${pad("load tsconfig")} ${settingsMs.toFixed(1)}ms`);
  console.log(`${pad("read files")} ${readMs.toFixed(1)}ms`);
  console.log(
    `${pad("extractSpecifiers (parse+walk)")} ${extractMs.toFixed(1)}ms  (${specifiers} specs)`,
  );
  console.log(
    `${pad("resolveSpecifier")} ${resolveMs.toFixed(1)}ms  (hit ${resolvedHits.ok} miss ${resolvedHits.miss})`,
  );
  console.log(
    `${pad("parse only, second pass")} ${parseMs.toFixed(1)}ms  (warmed createSourceFile)`,
  );

  const buildStart = now();
  const { graph } = buildGraphFromFiles(walked.files, srcRoot);
  const buildMs = now() - buildStart;
  const importerCount = [...graph.importers.values()].reduce((n, xs) => n + xs.length, 0);
  console.log(
    `${pad("buildGraphFromFiles")} ${buildMs.toFixed(1)}ms  (${importerCount} edges)`,
  );

  const shellsStart = now();
  const shells = getShells(graph);
  console.log(`${pad("getShells (SCC)")} ${(now() - shellsStart).toFixed(1)}ms  (${shells.size} shells)`);

  const gatesStart = now();
  const gates = getGates(graph);
  console.log(`${pad("getGates")} ${(now() - gatesStart).toFixed(1)}ms  (${gates.size} gates)`);

  const ownerStart = now();
  for (const file of graph.files) {
    getOwner(file, graph, srcRoot);
  }
  console.log(`${pad("getOwner all files")} ${(now() - ownerStart).toFixed(1)}ms`);

  const indexStart = now();
  const byDir = new Map<string, string[]>();
  for (const file of graph.files) {
    const dir = path.dirname(file);
    const list = byDir.get(dir);
    if (list === undefined) {
      byDir.set(dir, [file]);
    } else {
      list.push(file);
    }
  }
  const indexMs = now() - indexStart;

  const ownerIndexedStart = now();
  for (const file of graph.files) {
    let dir = path.dirname(file);
    while (true) {
      const siblings = byDir.get(dir) ?? [];
      const hit = siblings.some((candidate) => {
        const base = path.basename(candidate, path.extname(candidate));
        if (base === path.basename(dir)) {
          return true;
        }
        if (base !== "index") {
          return false;
        }
        return (graph.importers.get(candidate) ?? []).some(
          (importer) => path.dirname(importer) !== dir,
        );
      });
      if (hit || dir === srcRoot) {
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  console.log(
    `${pad("getOwner with files-by-dir index")} ${(now() - ownerIndexedStart).toFixed(1)}ms  (index build ${indexMs.toFixed(1)}ms, ${byDir.size} dirs)`,
  );

  const singletonStart = now();
  for (const file of graph.files) {
    const dir = path.dirname(file);
    if (dir === srcRoot) {
      continue;
    }
    countSourceFilesShallowish(dir, srcRoot);
  }
  console.log(`${pad("singleton readdir walks")} ${(now() - singletonStart).toFixed(1)}ms`);

  const findingsStart = now();
  let findingCount = 0;
  for (const file of graph.files) {
    findingCount += ownershipFindings(makeSubject(file, srcRoot, graph), srcRoot, []).length;
  }
  console.log(
    `${pad("ownershipFindings all files")} ${(now() - findingsStart).toFixed(1)}ms  (${findingCount} reports)`,
  );

  const entryStart = now();
  let crossings = 0;
  const resSettings = getGraphResolutionSettings(graph);
  for (const file of graph.files) {
    const content = safeReadFile(file);
    if (content === undefined) {
      continue;
    }
    for (const specifier of extractSpecifiers(content, file)) {
      const resolved = resolveSpecifier(specifier, path.dirname(file), resSettings);
      if (resolved === undefined) {
        continue;
      }
      const target = canonicalGraphPath(graph, resolved);
      if (findCrossedGate(target, file, graph, srcRoot) !== undefined) {
        crossings += 1;
      }
    }
  }
  console.log(
    `${pad("entry check all imports")} ${(now() - entryStart).toFixed(1)}ms  (${crossings} crossings)`,
  );

  if (process.env.SKIP_ESLINT === "1") {
    return;
  }

  await makeESLint(root, "none").lintFiles(["src/main.ts"]);

  const parserOnlyStart = now();
  await makeESLint(root, "none").lintFiles(["src/**/*.ts"]);
  const parserOnlyMs = now() - parserOnlyStart;

  const bothStart = now();
  const results = await makeESLint(root, "both").lintFiles(["src/**/*.ts"]);
  const bothMs = now() - bothStart;
  const pluginReports = results.reduce(
    (n, r) => n + r.messages.filter((m) => m.ruleId?.startsWith("colocate/")).length,
    0,
  );

  const ownershipStart = now();
  await makeESLint(root, "ownership").lintFiles(["src/**/*.ts"]);
  const ownershipMs = now() - ownershipStart;

  const entryOnlyStart = now();
  await makeESLint(root, "entry").lintFiles(["src/**/*.ts"]);
  const entryMs = now() - entryOnlyStart;

  const warmStart = now();
  await makeESLint(root, "both").lintFiles(["src/**/*.ts"]);
  const warmMs = now() - warmStart;

  console.log(`${pad("ESLint parser only (no rules)")} ${parserOnlyMs.toFixed(1)}ms`);
  console.log(
    `${pad("ESLint both rules (graph warm)")} ${bothMs.toFixed(1)}ms  (${pluginReports} reports)`,
  );
  console.log(`${pad("ESLint ownership only")} ${ownershipMs.toFixed(1)}ms`);
  console.log(`${pad("ESLint entry only")} ${entryMs.toFixed(1)}ms`);
  console.log(`${pad("ESLint both second pass")} ${warmMs.toFixed(1)}ms`);
  console.log(
    `${pad("plugin overhead vs parser")} ${((bothMs - parserOnlyMs) / parserOnlyMs * 100).toFixed(0)}% of parser-only (${(bothMs - parserOnlyMs).toFixed(1)}ms)`,
  );
}

async function main(): Promise<void> {
  console.log("file-ownership-lint performance probe");
  console.log(`node ${process.version}  sizes=${SIZES.join(",")}`);
  for (const size of SIZES) {
    await measureSize(size);
  }
}

await main();
