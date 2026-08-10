const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    languageOptions: {
      globals: { require: "readonly", module: "writable" }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
