import js from "@eslint/js";
import colocate from "@gosukiwi/eslint-plugin-colocate";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: {
      colocate,
    },
    rules: {
      "colocate/ownership": ["error", { root: "src" }],
      "colocate/entry": ["error", { root: "src" }],
    },
  },
  {
    ignores: ["dist/**", "coverage/**", "tests/fixtures/**"],
  },
);
