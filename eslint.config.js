import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // Flat config (ESLint 9+) dropped the old .eslintrc's implicit
    // "ignore all dotfolders" behavior, so anything under a dotfolder
    // (.venv/, .claude/, .codex/, tool caches, etc.) now needs an explicit
    // ignore or it gets linted - including any stray, untracked worktree
    // copies of already-deleted source files sitting under .claude/.
    ignores: ["node_modules/", "venv/", "**/.*/**"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
  },
];
