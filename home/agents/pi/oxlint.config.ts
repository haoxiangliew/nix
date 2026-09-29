import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc"],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  rules: {
    complexity: ["error", { max: 10, variant: "modified" }],
    curly: ["error", "all"],
    "oxc/no-accumulating-spread": "error",
    "typescript/consistent-return": "off",
  },
});
