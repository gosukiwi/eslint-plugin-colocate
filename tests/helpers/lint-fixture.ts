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

export function pick<K extends keyof FixtureMessage>(
  messages: FixtureMessage[],
  ...keys: K[]
): Pick<FixtureMessage, K>[] {
  return messages.map((message) => {
    const picked = {} as Pick<FixtureMessage, K>;
    for (const key of keys) {
      picked[key] = message[key];
    }
    return picked;
  });
}
