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
  options?: { parser?: "typescript" | "espree"; rule?: RuleName },
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
  const ruleName = options?.rule ?? "ownership";

  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
        plugins: {
          colocate: plugin,
        },
        rules: {
          [`colocate/${ruleName}`]: ["error", ruleOptions ?? {}],
        },
        languageOptions,
      },
    ],
  });
}

// The real collection loop lives here so the fatal-parse-error check has one
// implementation; collectMessages below is a thin projection onto the
// two-key shape the ownership assertions were already written against.
function collectRuleMessages(
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

export async function lintFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
  options?: { parser?: "typescript" | "espree" },
): Promise<{ file: string; messageId: string }[]> {
  const cwd = path.join(fixturesDir, name);
  const results = await makeESLint(cwd, ruleOptions, options).lintFiles(targets);
  return collectMessages(cwd, results);
}

export async function lintFixtureRule(
  name: string,
  rule: RuleName,
  ruleOptions?: Record<string, unknown>,
  targets: string[] = ["src"],
): Promise<FixtureMessage[]> {
  const cwd = path.join(fixturesDir, name);
  const results = await makeESLint(cwd, ruleOptions, { rule }).lintFiles(
    targets,
  );
  return collectRuleMessages(cwd, results, rule);
}
