import js from "@eslint/js";
import tseslint from "typescript-eslint";

const typeCheckedFiles = [
  "packages/*/src/**/*.{ts,tsx,mts,cts}",
  "tests/**/*.{ts,tsx,mts,cts}",
];

export default tseslint.config(
  {
    ignores: ["**/dist/**"],
  },
  {
    files: typeCheckedFiles,
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.strictTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", {
        assertionStyle: "as",
        objectLiteralTypeAssertions: "never",
      }],
      "@typescript-eslint/consistent-type-imports": ["error", {
        prefer: "type-imports",
      }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  // Dashboard-specific: ban raw transport.request() — use typed RPC client
  {
    files: ["packages/dashboard/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/lib/rpcClient.ts", "**/lib/wsTransport.ts"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='request'][callee.object.name='transport']",
        message: "Use typed RPC client instead of raw transport.request(). Import useRpcClient from lib/transportContext.",
      }],
    },
  },
);
