import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../../src/index.js";

const fixturesDir = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../fixtures",
);

export function makeESLint(
  cwd: string,
  ruleOptions?: Record<string, unknown>,
  options?: { parser?: "typescript" | "espree" },
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

  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}"],
        plugins: {
          "file-ownership-lint": plugin,
        },
        rules: {
          "file-ownership-lint/ownership": ["error", ruleOptions ?? {}],
        },
        languageOptions,
      },
    ],
  });
}

export function collectMessages(
  cwd: string,
  results: ESLint.LintResult[],
): { file: string; messageId: string }[] {
  const messages: { file: string; messageId: string }[] = [];
  const fatal: string[] = [];

  for (const result of results) {
    for (const message of result.messages) {
      if (message.fatal === true) {
        fatal.push(
          `${path.relative(cwd, result.filePath)}:${message.line} ${message.message}`,
        );
        continue;
      }
      if (message.ruleId === "file-ownership-lint/ownership" && message.messageId) {
        messages.push({
          file: path.relative(cwd, result.filePath),
          messageId: message.messageId,
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
