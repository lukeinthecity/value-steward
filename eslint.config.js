import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".venv/", "venv/"] },
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
