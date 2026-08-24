import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../../src/index.js";

const fixturesDir = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../fixtures",
);

export type RuleName = "ownership" | "entry";

export interface FixtureMessage {
  file: string;
  messageId: string;
  line: number;
  message: string;
}

export function makeESLint(
  cwd: string,
  ruleOptions?: Record<string, unknown>,
  options?: {
    parser?: "typescript" | "espree";
    rule?: RuleName | RuleName[];
  },
): ESLint {
  const languageOptions =
    options?.parser === "espree"
      ? {
          sourceType: "module" as const,
          ecmaVersion: 2022 as const,
        }
      : {
          parser: tsParser,
          parserOptions: {
            sourceType: "module",
            ecmaVersion: 2022,
          },
        };
  // Accepts several rule names so a cache test can enable both rules at once -
  // that is the configuration that exposed the getGraph double-call bug, and
  // no fixture-driven assertion needs more than one rule at a time.
  const ruleNames =
    options?.rule === undefined
      ? (["ownership"] as const)
      : Array.isArray(options.rule)
        ? options.rule
        : [options.rule];

  const rules: Record<string, [string, Record<string, unknown>]> = {};
  for (const ruleName of ruleNames) {
    rules[`colocate/${ruleName}`] = ["error", ruleOptions ?? {}];
  }

  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
        plugins: {
          colocate: plugin,
        },
        rules,
        languageOptions,
      },
    ],
  });
}

// The real collection loop lives here so the fatal-parse-error check has one
// implementation; collectMessages below is a thin projection onto the
// two-key shape the ownership assertions were already written against.
// Exported so a temp-directory test for a new rule (the makeESLint +
// collectMessages idiom in cache.test.ts) doesn't silently get `[]` back
// from collectMessages's hardcoded "colocate/ownership" filter.
export function collectRuleMessages(
  cwd: string,
  results: ESLint.LintResult[],
  ruleName: RuleName,
): FixtureMessage[] {
  const messages: FixtureMessage[] = [];
  const fatal: string[] = [];
  const ruleId = `colocate/${ruleName}`;

  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal === true) {
        fatal.push(
          `${path.relative(cwd, result.filePath)}:${message.line} ${message.message}`,
        );
        continue;
      }
      if (message.ruleId === ruleId && message.messageId) {
        messages.push({
          file: path.relative(cwd, result.filePath),
          messageId: message.messageId,
          line: message.line,
          message: message.message,
        });
      }
    }
  }

  // A fixture that stops parsing would otherwise silently satisfy every
  // "expect no messages" assertion.
  if (fatal.length > 0) {
    throw new Error(`fixture produced parse errors:\n${fatal.join("\n")}`);
  }

  return messages;
}

export function collectMessages(
  cwd: string,
  results: ESLint.LintResult[],
): { file: string; messageId: string }[] {
  return collectRuleMessages(cwd, results, "ownership").map(
    ({ file, messageId }) => ({ file, messageId }),
  );
}

// Ownership assertions compare whole objects with toEqual, so they want the
// two-key shape below. Reach for lintFixtureRule instead when a fixture
// packs several findings into one file and the assertion needs line/message
// to tell them apart.
export async function lintFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
  options?: { parser?: "typescript" | "espree" },
): Promise<{ file: string; messageId: string }[]> {
  const messages = await lintFixtureRule(
    name,
    "ownership",
    ruleOptions,
    targets,
    options,
  );
  return messages.map(({ file, messageId }) => ({ file, messageId }));
}

export async function lintFixtureRule(
  name: string,
  rule: RuleName,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
  options?: { parser?: "typescript" | "espree" },
): Promise<FixtureMessage[]> {
  const cwd = path.join(fixturesDir, name);
  const results = await makeESLint(cwd, ruleOptions, {
    ...options,
    rule,
  }).lintFiles(targets);
  return collectRuleMessages(cwd, results, rule);
}

export async function lintEntryFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
  options?: { parser?: "typescript" | "espree" },
): Promise<FixtureMessage[]> {
  return lintFixtureRule(name, "entry", ruleOptions, targets, options);
}
