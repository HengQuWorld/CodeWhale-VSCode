// ESLint flat config (ESLint 9+ / typescript-eslint 8+).
//
//   npm install      # once, to fetch the devDependencies below
//   npm run lint     # eslint src
//
// Kept deliberately close to the stock recommended sets: core `@eslint/js`
// rules plus typescript-eslint's non-type-checked recommended rules. Type-aware
// rules (`recommendedTypeChecked`) are intentionally NOT enabled — they need a
// project service and roughly double lint time for little extra signal here.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "webview/**", "media/**", "node_modules/**", "*.vsix"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `as any` at the webview plumbing boundary is deliberate; keep it
      // visible as a warning without failing the gate. Test files turn this
      // off entirely (see the override below).
      "@typescript-eslint/no-explicit-any": "warn",
      // The stock recommended set ships no ignore patterns. This codebase marks
      // intentionally-unused parameters with a leading underscore (handlers that
      // must match a shared signature, fake DOM doubles).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Test-only VSCode API doubles and fixture casts use `any` on purpose; the
    // gate still fails on every other rule there.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
