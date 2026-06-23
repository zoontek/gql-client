import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: ["example/**", "test/**"],
  plugins: ["react", "typescript"],
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error",
  },
  rules: {
    "no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", ignoreRestSiblings: true },
    ],

    "no-param-reassign": "error",
    "no-shadow": "off",
    "no-underscore-dangle": "off",
    "no-use-before-define": "error",
    "no-var": "error",

    "react/button-has-type": "error",
    "react/no-unstable-nested-components": "off",
    "react/prefer-function-component": "error",
    "react/react-in-jsx-scope": "off",

    "typescript/explicit-function-return-type": "error",
    "typescript/explicit-module-boundary-types": "error",
    "typescript/no-dynamic-delete": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-import-type-side-effects": "error",
    "typescript/no-invalid-void-type": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-wrapper-object-types": "off",
  },
});
