import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import plugin from "../../src/index.js";

const fixturesDir = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../fixtures",
);

export async function lintFixture(
  name: string,
  ruleOptions?: Record<string, unknown>,
): Promise<{ file: string; messageId: string }[]> {
  const cwd = path.join(fixturesDir, name);
  const eslint = new ESLint({
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
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            sourceType: "module",
            ecmaVersion: 2022,
          },
        },
      },
    ],
  });

  const results = await eslint.lintFiles(["src"]);
  const messages: { file: string; messageId: string }[] = [];

  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId === "file-ownership-lint/ownership" && message.messageId) {
        messages.push({
          file: path.relative(cwd, result.filePath),
          messageId: message.messageId,
        });
      }
    }
  }

  return messages;
}
