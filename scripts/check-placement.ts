/**
 * Placement satisfiability sweep.
 *
 * Every report this rule emits must be fixable: for a given project there has to
 * be *somewhere* the file can live that the rule accepts. Four separate bugs on
 * this project were reports that no location satisfied, so this generates random
 * layouts, places the subject file at every plausible location, and fails if any
 * configuration has no clean placement at all.
 *
 * Not part of `npm test` — it runs a few thousand lints. Run it after touching
 * the ownership model:
 *
 *     npm run check:placement
 *
 * Validated against the commit before the fix in ee22223: 51 of 200
 * configurations were unsatisfiable there, 0 afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../src/index.js";

const CASE_DIR = path.join(fs.realpathSync("/tmp"), "fol-placement");
const CONFIGS = Number(process.env.CONFIGS ?? 200);

let seed = Number(process.env.SEED ?? 987654);
const rnd = (): number =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const range = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));

const OWNER_DIRS = [
  "features/A",
  "features/B",
  "pages/C",
  "features/sub/D",
  "pages/deep/E",
];

type SubjectKind = "plain" | "entry" | "index";
interface Subject {
  kind: SubjectKind;
  name: string;
}

function spec(fromDir: string, target: string): string {
  const rel = path.posix.relative(fromDir, target);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Writes the whole project with the subject placed at `placement`. */
function emit(
  dir: string,
  owners: string[],
  consumers: number[],
  subject: Subject,
  placement: string,
  barrelInOwner: boolean,
): string {
  fs.rmSync(dir, { recursive: true, force: true });
  const files: Record<string, string> = {};

  const subjectPath =
    subject.kind === "plain"
      ? path.posix.join(placement, `${subject.name}.ts`)
      : path.posix.join(
          placement,
          subject.name,
          subject.kind === "entry" ? `${subject.name}.ts` : "index.ts",
        );
  // Consumers import the folder when the subject is an index file.
  const target =
    subject.kind === "index"
      ? path.posix.join(placement, subject.name)
      : subjectPath.replace(/\.ts$/, "");

  files[subjectPath] = "export const subject = 1;\n";
  if (subject.kind !== "plain") {
    // Keeps the subject's folder from being a singleton wrapper.
    files[path.posix.join(placement, subject.name, "sibling.ts")] =
      "export const s = 1;\n";
  }

  owners.forEach((ownerDir, i) => {
    const name = path.posix.basename(ownerDir);
    const entry = path.posix.join(ownerDir, `${name}.ts`);
    const imports = consumers.includes(i)
      ? `import "${spec(path.posix.dirname(entry), target)}";\n`
      : "";
    files[entry] = `${imports}export const owner${i} = 1;\n`;
    files[path.posix.join(ownerDir, `${name}.module.css`)] = ".o {}\n";
  });

  if (barrelInOwner && owners[0] !== undefined) {
    const name = path.posix.basename(owners[0]);
    files[path.posix.join(owners[0], "index.ts")] =
      `export * from "./${name}";\n`;
  }

  files["App.ts"] = owners
    .map(
      (o) =>
        `import "${spec(".", path.posix.join(o, path.posix.basename(o)))}";\n`,
    )
    .join("");
  files["main.ts"] = 'import "./App";\n';

  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, "src", rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  return path.posix.join("src", subjectPath);
}

async function reportsFor(
  dir: string,
  options: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const eslint = new ESLint({
    cwd: dir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        plugins: { p: plugin },
        rules: { "p/ownership": ["error", options] },
        languageOptions: {
          parser: tsParser,
          parserOptions: { sourceType: "module", ecmaVersion: 2022 },
        },
      },
    ],
  });

  const byFile: Record<string, string[]> = {};
  for (const result of await eslint.lintFiles(["src"])) {
    for (const message of result.messages) {
      const file = path.relative(dir, result.filePath);
      (byFile[file] ??= []).push(message.messageId ?? `FATAL:${message.message}`);
    }
  }
  return byFile;
}

let lints = 0;
const failures: string[] = [];

for (let n = 0; n < CONFIGS; n += 1) {
  const owners = OWNER_DIRS.slice(0, range(2, 4));
  const shuffled = owners.map((_, i) => i).sort(() => rnd() - 0.5);
  const consumers = shuffled
    .slice(0, range(1, owners.length))
    .sort((a, b) => a - b);
  const subject: Subject = {
    kind: pick(["plain", "entry", "index"] as const),
    name: pick(["Widget", "fmt", "Cart"]),
  };
  const barrelInOwner = rnd() < 0.4;

  const options: Record<string, unknown> = { root: "src" };
  if (rnd() < 0.3) options.layers = [pick(["features", "pages", "src/features"])];
  if (rnd() < 0.2) options.ignore = [pick(["**/*.generated.ts", "gen"])];

  const placements = new Set<string>([
    ".",
    "features",
    "pages",
    "shared",
    "features/sub",
    ...owners,
    ...owners.map((o) => path.posix.join(o, "parts")),
  ]);

  const dir = path.join(CASE_DIR, `c${n}`);
  const matrix: string[] = [];
  let clean = 0;

  for (const placement of placements) {
    const subjectFile = emit(
      dir,
      owners,
      consumers,
      subject,
      placement,
      barrelInOwner,
    );
    const own = (await reportsFor(dir, options))[subjectFile] ?? [];
    lints += 1;
    matrix.push(`${placement.padEnd(22)} ${own.join(",") || "(clean)"}`);
    if (own.length === 0) {
      clean += 1;
    }
  }

  if (clean === 0) {
    failures.push(
      `UNSATISFIABLE config#${n}: owners=${JSON.stringify(owners)} ` +
        `consumers=${JSON.stringify(consumers)} subject=${subject.kind}:${subject.name} ` +
        `options=${JSON.stringify(options)} barrelInOwner=${barrelInOwner}\n  ` +
        matrix.join("\n  "),
    );
  }
}

fs.rmSync(CASE_DIR, { recursive: true, force: true });

console.log(`configs=${CONFIGS} lints=${lints} unsatisfiable=${failures.length}`);
for (const failure of failures) {
  console.log(`\n${failure}`);
}
if (failures.length > 0) {
  process.exitCode = 1;
}
