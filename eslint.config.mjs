import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "build.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      "./README.md",
      "./tsconfig.json",
      "./package.json",
      "node_modules",
      ".prettierrc",
      "dist",
      "bun.lock",
    ],
  },
  {
    rules: {
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
);
